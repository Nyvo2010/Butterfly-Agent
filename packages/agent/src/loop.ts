import { access, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { COE, SCE, SCEOptions } from "@butterfly/context"
import { log } from "@butterfly/core"
import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
  LLMStreamEvent,
  LLMToolSpec,
  ProviderService,
  ToolCallParser,
} from "@butterfly/llm"
import type { SessionState, SessionStore, TodoItem, ToolCallRecord } from "@butterfly/session"
import { zeroUsage } from "@butterfly/session"
import type { Tool, ToolRegistry } from "@butterfly/tools"
import { isCommandSafe } from "@butterfly/tools"
import { kindsForMode } from "./modes"
import type { Plan } from "./planning"
import { extractPlanFromText, updatePlanFromToolResult } from "./planning"
import { buildSystemPrompt } from "./prompt"
import type { QualityMonitor } from "./quality-monitor"
import type { ModelResolution, ModelRouter } from "./router"

/**
 * Permission hook called before executing a tool. Return false to deny execution.
 * The tool name and input are provided for user-interface decisions.
 */
export type PermissionHook = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ allowed: boolean; reason?: string }>

/**
 * Minimal event sink interface for decoupled event publishing.
 *
 * The agent loop emits structured events through this sink so that the server
 * layer (or any other consumer) can subscribe without the agent package needing
 * to depend on the server. The server's EventBus satisfies this interface via a
 * thin adapter — see packages/server/src/app.ts.
 *
 * Inspired by OpenCode's GlobalBus: the loop publishes, the bus broadcasts.
 */
export interface AgentEventSink {
  emit(event: { kind: string; sessionId?: string; data?: Record<string, unknown> }): void
}

export interface AgentLoopDeps {
  /**
   * Single LLM client (backward compat). When not set, providerService
   * is used to create clients dynamically based on the resolved model.
   */
  llm?: LLMClient
  /**
   * Provider service for dynamic model selection (OpenCode-compatible).
   * When set, the loop creates LLM clients on demand based on the
   * session's selectedModel. Takes precedence over `llm` when both are set.
   */
  providerService?: ProviderService
  sce: SCE
  coe: COE
  router: ModelRouter
  registry: ToolRegistry
  store: SessionStore
  parser?: ToolCallParser
  /** Optional permission hook. Called before write/exec/delegate tools. */
  permissionHook?: PermissionHook
  /** Optional quality monitor for pre-execution tool call validation. */
  qualityMonitor?: QualityMonitor
  /** Optional streaming callback for live UI updates. */
  onStreamEvent?: (event: LLMStreamEvent) => void
  /** Optional callback after each iteration with current session state. */
  onIteration?: (session: SessionState, iteration: number) => void
  /**
   * Optional event sink for decoupled event publishing (server event bus).
   * When set, the loop emits tool/file/stream events through it so external
   * subscribers (HTTP /event SSE clients, etc.) can observe without coupling.
   */
  bus?: AgentEventSink
  /**
   * Optional callback to ask the user a question (human-in-the-loop).
   * Mirrors OpenCode's question tool pattern. When set, the ask_user tool
   * can pause execution to solicit user input.
   */
  onAskUser?: (question: string, options?: string[]) => Promise<string | null>
  /**
   * Optional mutable todo list ref. When set, the loop syncs the ref's
   * current value into the session before each save, and initializes it
   * from session.todos on the first iteration. This lets the todowrite tool
   * read/write a mutable ref without needing access to the session object.
   */
  todosRef?: { current: TodoItem[] }
}

export interface RunRequest {
  session: SessionState
  query: string
  cwd: string
  maxSteps?: number
  maxContextTokens?: number
  /** Per-tool-message token cap passed to COE. Default 2000. */
  toolMessageMaxTokens?: number
  sceOptions?: Partial<SCEOptions>
  /** Subagent recursion depth (0 = top-level, 1+ = nested). Used to prevent unbounded recursion. */
  subagentDepth?: number
  /** Optional active plan for TODO-driven planning. Updated in place by the loop. */
  plan?: Plan
  /** Optional project bootstrap summary injected once into the first user message. */
  bootstrapSummary?: string
  /** Optional AbortSignal to cancel the loop mid-execution. */
  signal?: AbortSignal
  /**
   * Allowed workspace roots for file access. If set, every file tool
   * operation must resolve within one of these directories. Prevents
   * path traversal outside the project. Defaults to [cwd] if not set.
   */
  workspaceRoots?: string[]
}

export type StopReason =
  | "no_tool_calls"
  | "error_max_escalation"
  | "max_steps"
  | "max_messages"
  | "save_failure"
  | "aborted"

export interface RunResult {
  session: SessionState
  lastResolution: ModelResolution
  iterations: number
  stopReason: StopReason
}

const MAX_MESSAGES = 200
const MAX_CONSECUTIVE_SAVE_FAILURES = 3

// ── Tool name predicates (centralized to avoid magic strings) ────────────────

/** Tools that modify files: write, patch, delete, diff_patch, or shell commands. */
function toolMatchesFileMutation(tool: Tool): boolean {
  return (
    tool.name === "write" ||
    tool.name === "patch" ||
    tool.name === "delete" ||
    tool.name === "diff_patch" ||
    tool.name === "bash"
  )
}

function isShellLikeTool(name: string): boolean {
  return name === "bash"
}

function isReadTool(name: string): boolean {
  return name === "read"
}

function isDeleteTool(name: string): boolean {
  return name === "delete"
}

function isDiffPatchTool(name: string): boolean {
  return name === "diff_patch"
}

function isSubagentTool(name: string): boolean {
  return name === "spawn_subagent"
}

/**
 * Check if a message is an intermediate assistant marker (tool invocation
 * or plan acknowledgment), not a substantive response to show the user.
 * Centralized so subagent.ts can reuse this logic.
 */
export function isIntermediateAssistantMessage(content: string): boolean {
  return content.startsWith("Using tools:") || content.startsWith("Plan created:")
}

// ── Internal types for tool execution ─────────────────────────────────────────

interface CallResult {
  call: { id: string; name: string; input: unknown }
  tool: Tool | null
  error: boolean
  result?: { kind: "ok"; output: unknown } | { kind: "err"; message: string }
  startedAt?: string
  finishedAt?: string
  readPath?: string
  beforeContent?: string
}

interface IterationState {
  messages: SessionState["messages"]
  toolCalls: ToolCallRecord[]
  fileChanges: SessionState["fileChanges"]
  readFiles: Set<string>
  stepHadFailure: boolean
}

// ── Agent Loop ───────────────────────────────────────────────────────────────

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  /** Save session to store, returning whether the save succeeded. */
  private async saveSession(session: SessionState): Promise<boolean> {
    try {
      await this.deps.store.save(session)
      return true
    } catch (e) {
      log("error", "agent.step.save_failed", { error: (e as Error).message })
      return false
    }
  }

  // ── Public run entry point ─────────────────────────────────────────────────

  async run(req: RunRequest): Promise<RunResult> {
    if (!req.query?.trim()) throw new Error("query is required")
    const maxSteps = req.maxSteps ?? 20
    const maxContextTokens = req.maxContextTokens ?? 8_000
    const workspaceRoots = req.workspaceRoots ?? [req.cwd]
    let session = this.primeSession(req)
    let consecutiveSaveFailures = 0

    // Restore persisted todos from the session into the mutable ref on first load.
    if (this.deps.todosRef && session.todos) {
      this.deps.todosRef.current = session.todos
    }

    let lastResolution: ModelResolution = this.deps.router.resolve(session.tier, 0)
    let iteration = 0
    let escalationDepth = 0

    while (iteration < maxSteps) {
      const stepLog = { iteration, sessionId: session.id, mode: session.mode }

      // Step 1: Resolve model
      const selectedModel = session.selectedModel ?? "auto"
      lastResolution = this.deps.router.resolve(session.tier, escalationDepth, selectedModel)
      log("info", "agent.step.resolve_model", {
        ...stepLog,
        tier: lastResolution.tier,
        model: lastResolution.model,
        escalationDepth: lastResolution.escalationDepth,
        selectedModel,
      })

      // Step 2: Run SCE (adaptive query, cache-aware)
      const slice = await this.runSCE(session, req, stepLog)

      // Step 3: Run COE (conditional on token budget)
      session = await this.runCOE(session, maxContextTokens, req.toolMessageMaxTokens, stepLog)
      log("info", "agent.step.coe_complete", {
        ...stepLog,
        messagesKept: session.messages.length,
        toolCallsKept: session.toolCalls.length,
        fileChanges: session.fileChanges.length,
      })

      if (session.messages.length > MAX_MESSAGES) {
        log("warn", "agent.stop.max_messages", {
          count: session.messages.length,
          max: MAX_MESSAGES,
        })
        await this.saveSession(session)
        return { session, lastResolution, iterations: iteration, stopReason: "max_messages" }
      }

      // Step 4: Build prompt + tool specs
      const { prompt, llmTools } = this.buildToolsAndPrompt(session, req, slice)

      // Step 5: Call LLM (streaming-first)
      let response: LLMResponse
      try {
        response = await this.callLLM(session, lastResolution.model, prompt, llmTools, stepLog)
      } catch (err) {
        log("error", "agent.step.llm_error", { ...stepLog, error: (err as Error).message })
        await this.saveSession(session)
        throw err
      }

      // Accumulate usage
      session = this.accumulateUsage(session, response)

      // Step 6: Parse text response as tool calls (parser-based LLMs)
      if (response.kind === "text" && this.deps.parser) {
        const parsed = this.deps.parser.parse(response.text)
        if (parsed && parsed.length > 0) {
          response = { kind: "tool_calls", calls: parsed, usage: response.usage }
        }
      }

      // Handle text response (no tool calls)
      if (response.kind === "text") {
        const handled = await this.handleTextResponse(
          session,
          response.text,
          req,
          lastResolution,
          iteration,
          maxSteps,
          stepLog,
        )
        if (handled.restart) {
          session = handled.session
          iteration++
          continue
        }
        return handled.result
      }

      // Step 7: Execute tool calls sequentially
      const iterState = await this.executeToolCalls(session, response, req, workspaceRoots, stepLog)

      // Step 8: Collect results and build updated session
      session = await this.collectResults(session, iterState, req, iteration)
      // Sync mutable todos ref into the session before persisting.
      if (this.deps.todosRef) {
        session = { ...session, todos: this.deps.todosRef.current }
      }

      const saved = await this.saveSession(session)
      if (!saved) {
        consecutiveSaveFailures++
        if (consecutiveSaveFailures >= MAX_CONSECUTIVE_SAVE_FAILURES) {
          log("error", "agent.stop.save_failure", { consecutiveFailures: consecutiveSaveFailures })
          return { session, lastResolution, iterations: iteration + 1, stopReason: "save_failure" }
        }
      } else {
        consecutiveSaveFailures = 0
      }

      this.deps.onIteration?.(session, iteration)
      log("info", "agent.step.iteration_appended", {
        ...stepLog,
        newMessageCount: session.messages.length,
        newToolCallCount: session.toolCalls.length,
        stepHadFailure: iterState.stepHadFailure,
      })

      // Step 9: Escalation + plan update on success
      if (req.plan && !iterState.stepHadFailure) {
        this.updatePlanFromResults(req.plan, response.calls)
      }

      // Abort check
      if (req.signal?.aborted) {
        log("info", "agent.stop.aborted", { ...stepLog })
        await this.saveSession(session)
        return { session, lastResolution, iterations: iteration + 1, stopReason: "aborted" }
      }

      // Escalation on failure
      if (iterState.stepHadFailure) {
        const escalated = this.deps.router.escalate(session.tier, escalationDepth, selectedModel)
        escalationDepth = escalated.depth
        session = { ...session, tier: escalated.tier }
        if (escalated.capped) {
          log("error", "agent.stop.escalation_capped", { ...stepLog, tier: session.tier })
          await this.saveSession(session)
          return {
            session,
            lastResolution,
            iterations: iteration + 1,
            stopReason: "error_max_escalation",
          }
        }
      }

      iteration++
    }

    log("warn", "agent.stop.max_steps", { maxSteps, sessionId: session.id })
    await this.saveSession(session)
    return { session, lastResolution, iterations: iteration, stopReason: "max_steps" }
  }

  // ── Private: Session initialization ──────────────────────────────────────

  /** Prime an empty session with the user's query as the first user turn. */
  private primeSession(req: RunRequest): SessionState {
    let session = req.session
    if (session.messages.length === 0) {
      const bootstrapPrefix = req.bootstrapSummary
        ? `[Project context: ${req.bootstrapSummary}]\n\n`
        : ""
      session = {
        ...session,
        messages: [
          {
            id: "msg-user-query",
            role: "user",
            content: `${bootstrapPrefix}${req.query}`,
            timestamp: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      }
    } else if (req.bootstrapSummary && !sessionHasBootstrap(session)) {
      const idx = session.messages.findIndex((m) => m.role === "user")
      if (idx !== -1) {
        const updated = {
          ...session.messages[idx],
          content: `[Project context: ${req.bootstrapSummary}]\n\n${session.messages[idx].content}`,
        }
        const newMessages = [...session.messages]
        newMessages[idx] = updated
        session = { ...session, messages: newMessages, updatedAt: new Date().toISOString() }
      }
    }
    return session
  }

  // ── Private: SCE ──────────────────────────────────────────────────────────

  private async runSCE(
    session: SessionState,
    req: RunRequest,
    stepLog: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<SCE["select"]>>> {
    const sceQuery = buildSCEQuery(session.messages, req.query)
    const hadFileChanges = session.fileChanges.length > 0
    const slice = await this.deps.sce.select(sceQuery, {
      cwd: req.cwd,
      ...req.sceOptions,
      skipCache: hadFileChanges,
    })
    log("info", "agent.step.sce_complete", {
      ...stepLog,
      grepMatches: slice.grepMatches.length,
      fileSnippets: slice.fileSnippets.length,
      files: slice.fileSnippets.map((f) => f.path),
    })
    return slice
  }

  // ── Private: COE ──────────────────────────────────────────────────────────

  private async runCOE(
    session: SessionState,
    maxContextTokens: number,
    toolMessageMaxTokens: number | undefined,
    _stepLog: Record<string, unknown>,
  ): Promise<SessionState> {
    const estimatedTokens = estimateTotalTokens(session)
    if (estimatedTokens > maxContextTokens * 0.7) {
      const optimized = await this.deps.coe.optimize(session, {
        maxContextTokens,
        ...(toolMessageMaxTokens !== undefined ? { toolMessageMaxTokens } : {}),
      })
      return { ...optimized, updatedAt: new Date().toISOString() }
    }
    return session
  }

  // ── Private: Build tools + prompt ────────────────────────────────────────

  private buildToolsAndPrompt(
    session: SessionState,
    req: RunRequest,
    slice: Awaited<ReturnType<SCE["select"]>>,
  ): { prompt: ReturnType<typeof buildSystemPrompt>; llmTools: LLMToolSpec[] } {
    const tools = this.deps.registry.listAllowed(kindsForMode(session.mode))
    const llmTools: LLMToolSpec[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
    const toolMetas = tools.map((t) => ({ name: t.name, kind: t.kind, description: t.description }))
    const prompt = buildSystemPrompt({
      mode: session.mode,
      query: req.query,
      sceSlice: slice,
      tools: toolMetas,
      plan: req.plan,
      includeToolList: this.deps.parser !== undefined,
    })
    return { prompt, llmTools }
  }

  // ── Private: LLM call ─────────────────────────────────────────────────────

  private async callLLM(
    session: SessionState,
    model: string,
    prompt: ReturnType<typeof buildSystemPrompt>,
    llmTools: LLMToolSpec[],
    stepLog: Record<string, unknown>,
  ): Promise<LLMResponse> {
    const llmMessages: LLMMessage[] = session.messages.map((m) => {
      if (m.role === "tool") return { role: "tool", content: m.content, toolCallId: m.toolCallId }
      if (m.role === "system") return { role: "system", content: m.content }
      if (m.role === "user") return { role: "user", content: m.content }
      return { role: "assistant", content: m.content }
    })

    const llm = this.deps.providerService
      ? this.deps.providerService.getClient(model)
      : this.deps.llm
    if (!llm)
      throw new Error("No LLM client available — neither llm nor providerService was configured")

    const req = {
      model,
      system: prompt.system,
      messages: llmMessages,
      tools: llmTools.length > 0 ? llmTools : undefined,
    }

    let response: LLMResponse
    if (llm.completeStream) {
      response = await completeWithStream(llm, req, this.deps.onStreamEvent ?? (() => {}))
    } else {
      response = await llm.complete(req)
    }

    log("info", "agent.step.llm_response", {
      ...stepLog,
      kind: response.kind,
      usage: response.usage,
      callCount: response.kind === "tool_calls" ? response.calls.length : 0,
    })
    return response
  }

  // ── Private: Usage accumulation ───────────────────────────────────────────

  private accumulateUsage(session: SessionState, response: LLMResponse): SessionState {
    if (!response.usage?.usageAvailable) return session
    const cur = session.usage ?? zeroUsage()
    const next = {
      ...session,
      usage: {
        promptTokens: cur.promptTokens + response.usage.promptTokens,
        completionTokens: cur.completionTokens + response.usage.completionTokens,
        totalTokens: cur.totalTokens + response.usage.totalTokens,
        usageAvailable: true,
        callCount: cur.callCount + 1,
      },
    }
    this.deps.bus?.emit({
      kind: "stream.usage",
      sessionId: session.id,
      data: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      },
    })
    return next
  }

  // ── Private: Handle text response (plan extraction) ───────────────────────

  private async handleTextResponse(
    session: SessionState,
    text: string,
    req: RunRequest,
    lastResolution: ModelResolution,
    iteration: number,
    maxSteps: number,
    stepLog: Record<string, unknown>,
  ): Promise<{ restart: true; session: SessionState } | { restart: false; result: RunResult }> {
    log("info", "agent.stop.no_tool_calls", { ...stepLog, finalTextChars: text.length })

    if (!req.plan && looksLikePlan(text) && iteration + 1 < maxSteps) {
      const extracted = extractPlanFromText(text, req.query.slice(0, 200))
      if (extracted.todos.length > 0) {
        req.plan = extracted
        log("info", "agent.plan.extracted_and_continue", {
          todos: extracted.todos.length,
          goal: extracted.goal,
        })
        const firstLine = text.split("\n")[0]?.slice(0, 120) ?? ""
        const continued = appendAssistantText(session, `Plan created: ${firstLine}`)
        await this.saveSession(continued)
        return { restart: true, session: continued }
      }
    }

    const finalSession = appendAssistantText(session, text)
    await this.saveSession(finalSession)
    return {
      restart: false,
      result: {
        session: finalSession,
        lastResolution,
        iterations: iteration + 1,
        stopReason: "no_tool_calls",
      },
    }
  }

  // ── Private: Execute tool calls ───────────────────────────────────────────

  private async executeToolCalls(
    session: SessionState,
    response: LLMResponse & { kind: "tool_calls" },
    req: RunRequest,
    workspaceRoots: string[],
    stepLog: Record<string, unknown>,
  ): Promise<IterationState & { callResults: CallResult[] }> {
    const iterState: IterationState = {
      messages: [...session.messages],
      toolCalls: [...session.toolCalls],
      fileChanges: [...session.fileChanges],
      readFiles: new Set(session.readFiles),
      stepHadFailure: false,
    }

    // Append assistant's tool-call decision message
    const toolCallNames = response.calls.map((c) => c.name).join(", ")
    iterState.messages.push({
      id: `msg-assistant-step-${session.messages.length}`,
      role: "assistant",
      content: `Using tools: ${toolCallNames}`,
      timestamp: new Date().toISOString(),
      toolCallId: `atc-${session.messages.length}`,
    })

    const callResults: CallResult[] = []
    for (const call of response.calls) {
      const cr = await this.executeOneTool(call, iterState, req, workspaceRoots, stepLog)
      callResults.push(cr)
    }
    return { ...iterState, callResults }
  }

  /** Execute a single tool call with permission checks, quality checks, and read-before-write protection. */
  private async executeOneTool(
    call: { id: string; name: string; input: unknown },
    iterState: IterationState,
    req: RunRequest,
    workspaceRoots: string[],
    stepLog: Record<string, unknown>,
  ): Promise<CallResult> {
    const tool = this.deps.registry.get(call.name)
    if (!tool) {
      log("warn", "agent.step.tool_unknown", { ...stepLog, name: call.name })
      return { call, tool: null, error: true }
    }

    // Permission check
    if (
      this.deps.permissionHook &&
      (tool.kind === "write" || tool.kind === "exec" || tool.kind === "delegate")
    ) {
      const perm = await this.deps.permissionHook(tool.name, asRecord(call.input))
      if (!perm.allowed) {
        log("info", "agent.step.permission_denied", {
          ...stepLog,
          name: call.name,
          reason: perm.reason,
        })
        return {
          call,
          tool,
          error: true,
          result: { kind: "err", message: perm.reason ?? `Permission denied for ${tool.name}` },
        }
      }
    }

    // Quality check
    if (this.deps.qualityMonitor) {
      const qc = this.deps.qualityMonitor.check(tool, asRecord(call.input))
      this.deps.qualityMonitor.logIssues(call.name, qc)
      if (!qc.valid && qc.severity === "error") {
        return {
          call,
          tool,
          error: true,
          result: { kind: "err", message: `Quality check failed: ${qc.issues.join("; ")}` },
        }
      }
    }

    const startedAt = new Date().toISOString()
    log("info", "agent.step.tool_start", {
      ...stepLog,
      name: call.name,
      args: call.input,
      startedAt,
    })
    this.deps.bus?.emit({
      kind: "tool.start",
      sessionId: req.session.id,
      data: { tool: call.name, input: call.input },
    })

    const rawPath = getInputPath(call.input)
    const path = rawPath ? normalizePath(rawPath, req.cwd) : ""

    // Checkpoint before mutation
    let beforeContent: string | undefined
    if (toolMatchesFileMutation(tool) && path) {
      try {
        beforeContent = await readFile(path, "utf8")
      } catch {
        /* new file */
      }
    }

    // Execute with read-before-write protection
    const result = await this.executeToolWithProtection(
      tool,
      call,
      path,
      rawPath,
      req,
      workspaceRoots,
      iterState,
    )
    const finishedAt = new Date().toISOString()

    // Track read files
    if (isReadTool(tool.name) && result.kind === "ok" && path) {
      iterState.readFiles.add(path)
    }

    return {
      call,
      tool,
      error: result.kind === "err",
      result,
      startedAt,
      finishedAt,
      beforeContent,
      readPath: isReadTool(tool.name) ? path : undefined,
    }
  }

  /** Execute a tool with read-before-write and safety checks. */
  private async executeToolWithProtection(
    tool: Tool,
    call: { id: string; name: string; input: unknown },
    path: string,
    rawPath: string,
    req: RunRequest,
    workspaceRoots: string[],
    iterState: IterationState,
  ): Promise<{ kind: "ok"; output: unknown } | { kind: "err"; message: string }> {
    const ctx = { cwd: req.cwd, onAskUser: this.deps.onAskUser, workspaceRoots }
    const isMutationTool = tool.kind === "write" || tool.kind === "exec"

    if (!isMutationTool) {
      return tool.execute(asRecord(call.input), ctx)
    }

    if (path) {
      if (iterState.readFiles.has(path)) {
        return tool.execute(asRecord(call.input), ctx)
      }
      try {
        await access(path)
        return { kind: "err", message: `File not read yet. Use read tool first: ${rawPath}` }
      } catch {
        return tool.execute(asRecord(call.input), ctx)
      }
    }

    // No path — bash/exec tool safety check
    if (isShellLikeTool(tool.name)) {
      const command = String((call.input as Record<string, unknown>).command ?? "")
      if (!isCommandSafe(command)) {
        return { kind: "err", message: "Command contains dangerous patterns and was blocked." }
      }
    } else {
      log("warn", "agent.tool.no_path", { tool: tool.name, input: call.input })
    }
    return tool.execute(asRecord(call.input), ctx)
  }

  // ── Private: Collect tool results ─────────────────────────────────────────

  private async collectResults(
    session: SessionState,
    iterState: IterationState,
    req: RunRequest,
    iteration: number,
  ): Promise<SessionState> {
    const { callResults } = iterState as IterationState & { callResults: CallResult[] }
    const logCtx = { sessionId: session.id }

    for (const cr of callResults) {
      const { call, tool, error, result: res, startedAt, finishedAt, beforeContent, readPath } = cr
      if (!tool || !res) {
        iterState.stepHadFailure = iterState.stepHadFailure || error
        continue
      }

      log("info", "agent.step.tool_result", {
        ...logCtx,
        name: call.name,
        kind: res.kind,
        outputBytes: res.kind === "ok" ? JSON.stringify(res.output).length : 0,
        message: res.kind === "err" ? res.message : undefined,
        finishedAt,
      })
      if (res.kind === "err") iterState.stepHadFailure = true

      this.deps.bus?.emit({
        kind: res.kind === "err" ? "tool.error" : "tool.result",
        sessionId: session.id,
        data: { tool: call.name, ...(res.kind === "err" ? { message: res.message } : {}) },
      })

      if (readPath) iterState.readFiles.add(readPath)

      const tcId = `tc-${call.id}-${iteration}`
      iterState.toolCalls.push({
        id: tcId,
        name: call.name,
        input: call.input,
        result: res.kind === "ok" ? res.output : undefined,
        error: res.kind === "err" ? res.message : undefined,
        startedAt: startedAt ?? finishedAt ?? new Date().toISOString(),
        finishedAt: finishedAt ?? new Date().toISOString(),
      })

      // Record file changes for successful mutations only
      if (toolMatchesFileMutation(tool) && res.kind === "ok") {
        const fPath = getInputPath(call.input) || "?"
        const kind = isDeleteTool(tool.name)
          ? "delete"
          : isDiffPatchTool(tool.name)
            ? "patch"
            : "write"

        let afterContent: string | undefined
        if (!isDeleteTool(tool.name) && fPath !== "?") {
          try {
            afterContent = await readFile(normalizePath(fPath, req.cwd), "utf8")
          } catch {
            /* new file */
          }
        }
        iterState.fileChanges.push({
          path: fPath,
          kind,
          before: beforeContent,
          after: afterContent,
          at: finishedAt ?? new Date().toISOString(),
        })
        this.deps.bus?.emit({
          kind: "file.changed",
          sessionId: session.id,
          data: { path: fPath, changeKind: kind },
        })
      }

      iterState.messages.push({
        id: `msg-${call.id}-${iteration}`,
        role: "tool",
        content: toolMessageContent(res),
        toolCallId: call.id,
        timestamp: finishedAt ?? new Date().toISOString(),
      })
    }

    return {
      ...session,
      messages: iterState.messages,
      toolCalls: iterState.toolCalls,
      fileChanges: iterState.fileChanges,
      readFiles: Array.from(iterState.readFiles),
      updatedAt: new Date().toISOString(),
    }
  }

  // ── Private: Plan helpers ─────────────────────────────────────────────────

  private updatePlanFromResults(
    plan: Plan,
    calls: Array<{ id: string; name: string; input: unknown }>,
  ): void {
    for (const call of calls) {
      const tool = this.deps.registry.get(call.name)
      if (tool && (toolMatchesFileMutation(tool) || isSubagentTool(call.name))) {
        updatePlanFromToolResult(plan, call.name, asRecord(call.input), true)
      }
    }
  }
}

// ── Free functions ───────────────────────────────────────────────────────────

async function completeWithStream(
  llm: LLMClient,
  req: { model: string; system: string; messages: LLMMessage[]; tools?: LLMToolSpec[] },
  onEvent: (event: LLMStreamEvent) => void,
): Promise<LLMResponse> {
  const guard = llm.completeStream
  if (!guard) throw new Error("LLM does not support streaming")
  const stream = await guard(req)
  let text = ""
  const toolCalls = new Map<string, { id: string; name: string; input: unknown }>()
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, usageAvailable: false }
  let streamError: string | null = null

  for await (const event of stream) {
    onEvent(event)
    switch (event.kind) {
      case "text_delta":
        text += event.text
        break
      case "reasoning_start":
      case "reasoning_delta":
      case "reasoning_end":
        break
      case "tool_call_delta": {
        const existing = toolCalls.get(event.id) ?? { id: event.id, name: "", input: undefined }
        if (event.name) existing.name = event.name
        if (event.input !== undefined) existing.input = event.input
        toolCalls.set(event.id, existing)
        break
      }
      case "done":
        usage = event.usage
        break
      case "error":
        streamError = event.message
        break
    }
  }

  if (streamError) throw new Error(`LLM stream error: ${streamError}`)

  if (toolCalls.size > 0) {
    return {
      kind: "tool_calls",
      calls: Array.from(toolCalls.values()).map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: asRecord(tc.input),
      })),
      usage,
    }
  }
  return { kind: "text", text, usage }
}

function toolMessageContent(
  result: { kind: "ok"; output: unknown } | { kind: "err"; message: string },
): string {
  if (result.kind === "ok") {
    return typeof result.output === "string" ? result.output : JSON.stringify(result.output)
  }
  return `ERROR: ${result.message.slice(0, 1000)}`
}

function getInputPath(input: unknown): string {
  if (typeof input !== "object" || !input) return ""
  const obj = input as Record<string, unknown>
  return typeof obj.path === "string" ? obj.path : ""
}

function normalizePath(rawPath: string, cwd: string): string {
  return rawPath.startsWith("/") ? rawPath : resolve(cwd, rawPath)
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || !input) return {}
  return input as Record<string, unknown>
}

function appendAssistantText(session: SessionState, text: string): SessionState {
  return {
    ...session,
    messages: [
      ...session.messages,
      {
        id: `msg-assistant-${Date.now()}`,
        role: "assistant",
        content: text,
        timestamp: new Date().toISOString(),
      },
    ],
    updatedAt: new Date().toISOString(),
  }
}

function buildSCEQuery(
  messages: Array<{ role: string; content: string }>,
  originalQuery: string,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (
      m.role === "assistant" &&
      m.content.length > 50 &&
      !isIntermediateAssistantMessage(m.content)
    ) {
      return `${originalQuery.slice(0, 200)} | ${m.content.slice(0, 300)}`
    }
    if (m.role === "tool" && m.content.length > 100) {
      return `${originalQuery.slice(0, 200)} | ${m.content.slice(0, 200)}`
    }
  }
  return originalQuery
}

function looksLikePlan(text: string): boolean {
  if (text.length < 50) return false
  const checkboxCount = (text.match(/^[-*]\s+\[[ xX]\]/gm) ?? []).length
  if (checkboxCount >= 2) return true
  return (text.match(/^\d+\.\s+/gm) ?? []).length >= 3
}

function estimateTotalTokens(session: SessionState): number {
  let charSum = 0
  for (const m of session.messages) charSum += m.content.length
  return Math.ceil(charSum / 4)
}

function sessionHasBootstrap(session: SessionState): boolean {
  return session.messages.some(
    (m) => m.role === "user" && m.content.startsWith("[Project context:"),
  )
}
