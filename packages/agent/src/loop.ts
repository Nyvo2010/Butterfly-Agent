import { access, readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { COE, Compressor, SCE, SCEOptions } from "@butterfly/context"
import { log } from "@butterfly/core"
import {
  classifyFailure,
  type FailureCategory,
  type LLMClient,
  type LLMMessage,
  type LLMResponse,
  type LLMStream,
  type LLMStreamEvent,
  type LLMToolSpec,
  type ProviderService,
  sleep,
  type ToolCallParser,
} from "@butterfly/llm"
import type {
  MessagePart,
  SessionState,
  SessionStore,
  TodoItem,
  ToolCallRecord,
} from "@butterfly/session"
import { zeroUsage } from "@butterfly/session"
import type { Tool, ToolRegistry } from "@butterfly/tools"
import { isCommandSafe } from "@butterfly/tools"
import type { AskUserCallback } from "./ask-user"
import { ToolLoopTracker } from "./loop-detector"
import { kindsForMode } from "./modes"
import type { Plan } from "./planning"
import { extractPlanFromText, updatePlanFromToolResult } from "./planning"
import { buildSystemPrompt } from "./prompt"
import type { QualityMonitor } from "./quality-monitor"
import type { ModelResolution, ModelRouter } from "./router"

/**
 * Permission hook called before executing a tool. Return false to deny execution.
 * The tool name, input, and (when known) the session id are provided for
 * user-interface decisions and per-session approved-rule memory.
 */
export type PermissionHook = (
  toolName: string,
  input: Record<string, unknown>,
  sessionId?: string,
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
  /**
   * Loop detector for repeat/no-progress/wandering protection.
   * When set, the loop consults it before each tool call, vetoes critical
   * repeats, and injects notices into subsequent prompts. When absent, a
   * fresh tracker is created per run.
   */
  loopDetector?: ToolLoopTracker
  /**
   * Semantic compressor for in-loop summarization. When set, COE uses it to
   * summarize old messages instead of only dropping them — SmallCode/Atomic
   * style context preservation for small context windows.
   */
  compressor?: Compressor
  /** Max retries for transient LLM failures (rate limit, 5xx, timeout). Default 2. */
  llmRetries?: number
  /** Base backoff (ms) for transient LLM retries — doubles per attempt. Default 500. */
  llmRetryBackoffMs?: number
  /**
   * Overall deadline for a streamed LLM completion (ms). Prevents a stalled
   * provider connection from hanging the loop forever. Default 10 minutes.
   */
  llmStreamTimeoutMs?: number
  /**
   * Idle timeout for a streamed LLM completion (ms) — trips when no events
   * arrive for this long, even if the overall deadline hasn't been reached.
   * Default 90 seconds.
   */
  llmStreamIdleTimeoutMs?: number
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
  onAskUser?: AskUserCallback
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
  /** Per-request temperature override passed to the LLM. */
  temperature?: number
  /** Provider-specific options forwarded into the LLM request body. */
  llmOptions?: Record<string, unknown>
  /** Extra HTTP headers forwarded to the LLM provider. */
  llmRequestHeaders?: Record<string, string>
  /** Extra body fields forwarded to the LLM provider. */
  llmRequestBody?: Record<string, unknown>
  /**
   * Custom slash commands for prompt pre-processing. When the query starts with
   * "/", the loop resolves it against this map and rewrites the query to the
   * command's prompt template (with {args} replaced by the remainder).
   *
   * Example: command "fix" → "Fix the following: {args}"
   * User: "/fix the login button" → query becomes "Fix the following: the login button"
   *
   * A future client can discover these via GET /api/commands.
   */
  commands?: Record<string, string>
  /**
   * Pre-resolved external file references. Each entry is a path to a file that
   * should be read and injected into the context as additional snippets.
   *
   * The server extracts these from the prompt (e.g. @path/to/file.ts) before
   * passing to the loop. The loop reads the referred files and adds them to
   * the SCE slice so the model sees their content without needing an explicit
   * read tool call.
   *
   * Example: user writes "refactor @src/utils.ts" → server resolves @src/utils.ts
   * and passes { refs: ["src/utils.ts"] }. The loop reads the file content.
   */
  refs?: string[]
}

export type StopReason =
  | "no_tool_calls"
  | "error_max_escalation"
  | "max_steps"
  | "max_messages"
  | "save_failure"
  | "aborted"
  /** The loop detector tripped its breaker (consecutive vetoed repeats). */
  | "loop_breaker"

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
  /**
   * Whether this failure should trigger model escalation.
   * False for permission denials, quality blocks, and loop-detector vetoes
   * (those are user/safety decisions, not model capability failures).
   */
  escalatable?: boolean
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
  /** Whether any failure this step was a model-capability failure (escalate). */
  escalatableFailure: boolean
  /** Loop-detector notices collected this step, injected into the next prompt. */
  notices: string[]
  /** Set when the loop detector's breaker trips — force a graceful reply. */
  loopBreaker?: boolean
  /** Final message text when the breaker trips. */
  loopBreakerMessage?: string
}

// ── Agent Loop ───────────────────────────────────────────────────────────────

export class AgentLoop {
  /** Active loop detector for the current run (set in run()). */
  private activeLoopDetector: ToolLoopTracker = new ToolLoopTracker()

  constructor(private readonly deps: AgentLoopDeps) {}

  private get loopDetector(): ToolLoopTracker {
    return this.activeLoopDetector
  }

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
    // ── Slash command resolution ───────────────────────────────────────
    // If the query starts with "/<name>", resolve it against the configured
    // commands map. The command's prompt template uses {args} as a placeholder
    // for the remainder of the user's input.
    if (req.commands && req.query.startsWith("/")) {
      const firstSpace = req.query.indexOf(" ")
      const cmdName = firstSpace === -1 ? req.query.slice(1) : req.query.slice(1, firstSpace)
      const cmdArgs = firstSpace === -1 ? "" : req.query.slice(firstSpace + 1).trim()
      const template = req.commands[cmdName]
      if (template) {
        const rewritten = template.replace("{args}", cmdArgs).trim()
        log("info", "agent.slash_command", {
          command: cmdName,
          original: req.query.slice(0, 100),
          rewritten: rewritten.slice(0, 200),
        })
        req = { ...req, query: rewritten }
      } else {
        log("warn", "agent.slash_command_unknown", {
          command: cmdName,
          available: Object.keys(req.commands),
        })
      }
    }
    const maxSteps = req.maxSteps ?? 20
    const maxContextTokens = req.maxContextTokens ?? 8_000
    const workspaceRoots = req.workspaceRoots ?? [req.cwd]
    // Per-run LLM request extras (temperature, options, headers, body) are
    // captured in a local so concurrent run() calls on the same loop instance
    // (e.g. the cached ACP agent) cannot race on shared state.
    const llmExtras: {
      temperature?: number
      options?: Record<string, unknown>
      headers?: Record<string, string>
      body?: Record<string, unknown>
    } = {
      temperature: req.temperature,
      options: req.llmOptions,
      headers: req.llmRequestHeaders,
      body: req.llmRequestBody,
    }
    let session = await this.primeSession(req)
    let consecutiveSaveFailures = 0

    // Restore persisted todos from the session into the mutable ref on first load.
    if (this.deps.todosRef && session.todos) {
      this.deps.todosRef.current = session.todos
    }

    // Loop detector — one per run so prior runs don't leak history into new ones.
    this.activeLoopDetector = this.deps.loopDetector ?? new ToolLoopTracker()

    let lastResolution: ModelResolution = this.deps.router.resolve(session.tier, 0)
    let iteration = 0
    let escalationDepth = 0
    let notices: string[] = []

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

      // Step 4: Build prompt + tool specs (loop-detector notices injected here)
      const { prompt, llmTools } = this.buildToolsAndPrompt(session, req, slice, notices)
      notices = []

      // Step 5: Call LLM (streaming-first, with transient-failure retry inside).
      // callLLM logs the classified error and persists state before throwing.
      // `let` because the parser path below may re-type the response to tool_calls.
      let response = await this.callLLM(
        session,
        lastResolution.model,
        prompt,
        llmTools,
        stepLog,
        llmExtras,
      )

      // Accumulate usage + estimated cost
      session = await this.accumulateUsage(session, response, lastResolution.model)

      // Step 6: Parse text response as tool calls (parser-based LLMs)
      if (response.kind === "text" && this.deps.parser) {
        const parsed = this.deps.parser.parse(response.text)
        if (parsed && parsed.length > 0) {
          response = {
            kind: "tool_calls",
            calls: parsed,
            usage: response.usage,
            reasoning: response.reasoning,
          }
        }
      }

      // Handle text response (no tool calls)
      if (response.kind === "text") {
        const handled = await this.handleTextResponse(
          session,
          response.text,
          response.reasoning,
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

      // Step 7: Execute tool calls (parallel-safe reads run concurrently)
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
        this.updatePlanFromResults(req.plan, response.calls, iterState.callResults)
      }

      // Loop-detector notices collected during execution flow into the next prompt.
      if (iterState.notices.length > 0) notices = iterState.notices

      // Loop breaker: repeated vetoes — force a graceful reply and stop.
      if (iterState.loopBreaker) {
        log("warn", "agent.stop.loop_breaker", { ...stepLog })
        const finalMsg = appendAssistantText(session, iterState.loopBreakerMessage ?? "")
        await this.saveSession(finalMsg)
        return {
          session: finalMsg,
          lastResolution,
          iterations: iteration + 1,
          stopReason: "loop_breaker",
        }
      }

      // Abort check
      if (req.signal?.aborted) {
        log("info", "agent.stop.aborted", { ...stepLog })
        await this.saveSession(session)
        return { session, lastResolution, iterations: iteration + 1, stopReason: "aborted" }
      }

      // Escalation on real model-capability failures only.
      // Permission denials, quality blocks, and loop vetoes do NOT escalate.
      if (iterState.stepHadFailure && iterState.escalatableFailure) {
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
  private async primeSession(req: RunRequest): Promise<SessionState> {
    let session = req.session
    if (session.messages.length === 0) {
      const bootstrapPrefix = req.bootstrapSummary
        ? `[Project context: ${req.bootstrapSummary}]\n\n`
        : ""
      // ── External file references ───────────────────────────────────
      // Resolve @path references in the query by reading the files and
      // injecting them as context right after the query.
      let refsBlock = ""
      if (req.refs && req.refs.length > 0) {
        const refContents: string[] = []
        for (const refPath of req.refs) {
          const abs = refPath.startsWith("/") ? refPath : resolve(req.cwd, refPath)
          try {
            const st = await stat(abs)
            if (st.size > 1024 * 1024) {
              refContents.push(
                `[SKIPPED: ${refPath} — file too large (${(st.size / 1024).toFixed(0)}KB)]`,
              )
              continue
            }
            const content = await readFile(abs, "utf8")
            refContents.push(`--- ${refPath} ---\n${content}`)
          } catch {
            refContents.push(`[SKIPPED: ${refPath} — could not read]`)
          }
        }
        if (refContents.length > 0) {
          refsBlock = `\n\nREFERENCED FILES:\n${refContents.join("\n\n")}`
        }
      }

      session = {
        ...session,
        messages: [
          {
            id: "msg-user-query",
            role: "user",
            content: `${bootstrapPrefix}${req.query}${refsBlock}`,
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
        ...(this.deps.compressor ? { compressor: this.deps.compressor } : {}),
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
    notices: string[] = [],
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
      notices,
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
    extras?: {
      temperature?: number
      options?: Record<string, unknown>
      headers?: Record<string, string>
      body?: Record<string, unknown>
    },
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
      ...(extras?.temperature !== undefined ? { temperature: extras.temperature } : {}),
      ...(extras?.options ? { options: extras.options } : {}),
      ...(extras?.headers ? { requestHeaders: extras.headers } : {}),
      ...(extras?.body ? { requestBody: extras.body } : {}),
    }

    // Transient-failure retry with exponential backoff (Atomic-style reliability).
    // Only retryable categories (rate_limit, timeout, server_error, network) retry;
    // auth/model/context failures fail fast so escalation logic stays honest.
    const maxRetries = this.deps.llmRetries ?? 2
    const backoffMs = this.deps.llmRetryBackoffMs ?? 500
    let lastError: unknown
    let lastCategory: FailureCategory = "unknown"
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let response: LLMResponse
        if (llm.completeStream) {
          response = await completeWithStream(llm, req, this.deps.onStreamEvent ?? (() => {}), {
            timeoutMs: this.deps.llmStreamTimeoutMs,
            idleTimeoutMs: this.deps.llmStreamIdleTimeoutMs,
          })
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
      } catch (err) {
        lastError = err
        const classified = classifyFailure(err)
        lastCategory = classified.category
        if (!classified.retryable || attempt >= maxRetries) {
          break
        }
        const wait = backoffMs * 2 ** attempt
        log("warn", "agent.step.llm_retry", {
          ...stepLog,
          attempt: attempt + 1,
          maxRetries,
          category: classified.category,
          backoffMs: wait,
        })
        await sleep(wait)
      }
    }
    log("error", "agent.step.llm_error", {
      ...stepLog,
      error: (lastError as Error)?.message ?? String(lastError),
      category: lastCategory,
      retried: maxRetries,
    })
    await this.saveSession(session)
    throw lastError
  }

  // ── Private: Usage accumulation ───────────────────────────────────────────

  private async accumulateUsage(
    session: SessionState,
    response: LLMResponse,
    model: string,
  ): Promise<SessionState> {
    if (!response.usage?.usageAvailable) return session
    const cur = session.usage ?? zeroUsage()
    const usage = {
      promptTokens: cur.promptTokens + response.usage.promptTokens,
      completionTokens: cur.completionTokens + response.usage.completionTokens,
      totalTokens: cur.totalTokens + response.usage.totalTokens,
      usageAvailable: true,
      callCount: cur.callCount + 1,
      costUsd: cur.costUsd ?? 0,
    }

    // Estimate cost from model pricing (best-effort, never blocks the loop).
    let costKnown = false
    if (this.deps.providerService) {
      try {
        const price = await this.deps.providerService.costFor(model)
        if (price) {
          costKnown = true
          const promptCost = (response.usage.promptTokens / 1_000_000) * price.input
          const completionCost = (response.usage.completionTokens / 1_000_000) * price.output
          usage.costUsd = Math.round((usage.costUsd + promptCost + completionCost) * 1e6) / 1e6
        }
      } catch {
        // Cost is best-effort — never let pricing failure break the run.
      }
    }

    const next = { ...session, usage }
    this.deps.bus?.emit({
      kind: "stream.usage",
      sessionId: session.id,
      data: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
        ...(costKnown ? { costUsd: usage.costUsd } : {}),
      },
    })
    return next
  }

  // ── Private: Handle text response (plan extraction) ───────────────────────

  private async handleTextResponse(
    session: SessionState,
    text: string,
    reasoning: string | undefined,
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

    const finalSession = appendAssistantText(session, text, reasoning)
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

  /**
   * Tools that are safe to execute concurrently. Pure reads with no shared
   * mutable state — mirrors Atomic Agent's `pure_read` resource class. Writes,
   * execs, and user-interactive tools always run serially to keep behavior
   * deterministic and approval flows ordered.
   */
  private isParallelSafe(call: { name: string }): boolean {
    switch (call.name) {
      case "read":
      case "grep":
      case "glob":
      case "list":
      case "search":
      case "lsp":
      case "web_fetch":
        return true
      default:
        return false
    }
  }

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
      escalatableFailure: false,
      notices: [],
    }

    // Append assistant's tool-call decision message with structured parts.
    const toolCallNames = response.calls.map((c) => c.name).join(", ")
    const assistantParts: MessagePart[] = []
    if (response.reasoning) {
      assistantParts.push({ type: "reasoning", text: response.reasoning })
    }
    assistantParts.push({ type: "text", text: `Using tools: ${toolCallNames}` })
    for (const c of response.calls) {
      assistantParts.push({ type: "tool_call", id: c.id, name: c.name, input: c.input })
    }
    iterState.messages.push({
      id: `msg-assistant-step-${session.messages.length}`,
      role: "assistant",
      content: `Using tools: ${toolCallNames}`,
      parts: assistantParts,
      timestamp: new Date().toISOString(),
      toolCallId: `atc-${session.messages.length}`,
    })

    // Split into a parallel-safe batch + serial remainder, keeping original indices
    // so results can be reassembled in model order for the transcript.
    const parallelBatch: Array<{ call: (typeof response.calls)[number]; index: number }> = []
    const serialCalls: Array<{ call: (typeof response.calls)[number]; index: number }> = []
    response.calls.forEach((call, index) => {
      if (this.isParallelSafe(call)) parallelBatch.push({ call, index })
      else serialCalls.push({ call, index })
    })

    const callResults: CallResult[] = new Array<CallResult>(response.calls.length)

    // Phase 1: execute the parallel-safe batch concurrently.
    const parallelResults = await Promise.allSettled(
      parallelBatch.map(({ call }) =>
        this.executeOneTool(call, iterState, req, workspaceRoots, stepLog),
      ),
    )
    for (let i = 0; i < parallelResults.length; i++) {
      const r = parallelResults[i]
      const index = parallelBatch[i].index
      if (r.status === "fulfilled") {
        callResults[index] = r.value
      } else {
        // A tool executor threw (shouldn't happen — tools return err results).
        callResults[index] = {
          call: parallelBatch[i].call,
          tool: null,
          error: true,
          escalatable: false,
          result: { kind: "err", message: (r.reason as Error)?.message ?? String(r.reason) },
        }
      }
    }

    // Phase 2: execute the rest serially in model order.
    for (const { call, index } of serialCalls) {
      callResults[index] = await this.executeOneTool(call, iterState, req, workspaceRoots, stepLog)
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
      return { call, tool: null, error: true, escalatable: false }
    }

    // Loop-detector pre-check — veto critical repeats before they execute.
    const verdict = this.loopDetector.check(call.name, call.input)
    if (verdict.level === "critical") {
      const notice = this.loopDetector.noticeFor(verdict) ?? `Repeated failing action: ${call.name}`
      iterState.notices.push(notice)
      const breaker = this.loopDetector.registerVeto(verdict)
      if (breaker) {
        iterState.loopBreaker = true
        iterState.loopBreakerMessage =
          `I was unable to make progress — ${call.name} kept failing after ` +
          `repeated attempts. Stopping here to avoid wasting more steps.`
      }
      log("warn", "agent.step.tool_vetoed", {
        ...stepLog,
        name: call.name,
        detector: verdict.detector,
        count: verdict.count,
      })
      return {
        call,
        tool,
        error: true,
        escalatable: false,
        result: { kind: "err", message: `Tool call vetoed by loop detector: ${notice}` },
      }
    }
    if (verdict.level === "warn") {
      const notice = this.loopDetector.noticeFor(verdict)
      if (notice) iterState.notices.push(notice)
    }

    // Permission check
    if (
      this.deps.permissionHook &&
      (tool.kind === "write" || tool.kind === "exec" || tool.kind === "delegate")
    ) {
      const perm = await this.deps.permissionHook(tool.name, asRecord(call.input), req.session.id)
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
          escalatable: false,
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
          escalatable: false,
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

    // Record the outcome with the loop detector (a success resets the streak).
    this.loopDetector.record(call.name, call.input, result.kind === "ok")
    if (result.kind === "ok") this.loopDetector.clearVetoes(verdict)

    return {
      call,
      tool,
      error: result.kind === "err",
      escalatable: result.kind === "err",
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
    const ctx = {
      cwd: req.cwd,
      onAskUser: this.deps.onAskUser,
      workspaceRoots,
      subagentDepth: req.subagentDepth ?? 0,
    }
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
        if (error && cr.escalatable !== false) iterState.escalatableFailure = true
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
      if (res.kind === "err") {
        iterState.stepHadFailure = true
        if (cr.escalatable !== false) iterState.escalatableFailure = true
      }

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
        parts: [
          {
            type: "tool_result",
            toolCallId: call.id,
            output: res.kind === "ok" ? res.output : { error: res.message },
          },
        ],
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
    callResults: CallResult[],
  ): void {
    for (const call of calls) {
      const tool = this.deps.registry.get(call.name)
      if (tool && (toolMatchesFileMutation(tool) || isSubagentTool(call.name))) {
        const cr = callResults.find((r) => r.call.id === call.id)
        const success = cr ? !cr.error : false
        updatePlanFromToolResult(plan, call.name, asRecord(call.input), success)
      }
    }
  }
}

// ── Free functions ───────────────────────────────────────────────────────────

interface StreamWatchdog {
  timeoutMs?: number
  idleTimeoutMs?: number
}

const DEFAULT_STREAM_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes overall
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90 * 1000 // 90s without any event

/**
 * Iterate an LLM stream with an overall + idle watchdog.
 * Yields every event; throws a descriptive error when a deadline is exceeded.
 *
 * Each `next()` is raced against a fresh idle timer (re-armed per chunk) and an
 * overall timer (remaining budget). Whichever fires first resolves the race with
 * `done`, breaking the loop, and the deadline reason is thrown afterwards. The
 * abandoned `next()` promise is left for the source stream to settle — the
 * watchdog's job is to stop *this* consumer from hanging forever.
 */
async function* withStreamWatchdog(
  stream: LLMStream,
  watchdog: StreamWatchdog,
): AsyncGenerator<LLMStreamEvent> {
  const overallMs = watchdog.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS
  const idleMs = watchdog.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const iterator = stream[Symbol.asyncIterator]()
  const started = Date.now()
  let deadlineHit: "overall" | "idle" | null = null

  try {
    while (true) {
      const remaining = overallMs - (Date.now() - started)
      if (remaining <= 0) {
        deadlineHit = "overall"
        break
      }

      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let overallTimer: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<LLMStreamEvent>>((resolve) => {
          idleTimer = setTimeout(() => {
            deadlineHit = "idle"
            resolve({ done: true, value: undefined })
          }, idleMs)
          overallTimer = setTimeout(() => {
            deadlineHit = "overall"
            resolve({ done: true, value: undefined })
          }, remaining)
        }),
      ])
      if (idleTimer) clearTimeout(idleTimer)
      if (overallTimer) clearTimeout(overallTimer)

      if (deadlineHit) break
      if (result.done) break
      yield result.value
    }
  } finally {
    // On a deadline, tear down the source iterator so the underlying
    // connection (fetch body reader / SDK stream) is actually closed — not
    // just abandoned. Prevents timed-out streams from leaking connections.
    if (deadlineHit) {
      try {
        await iterator.return?.()
      } catch {
        /* best-effort teardown */
      }
    }
  }

  const elapsed = Date.now() - started
  if (deadlineHit === "overall") {
    throw new Error(
      `LLM stream timed out after ${Math.round(elapsed / 1000)}s (overall limit ${Math.round(overallMs / 1000)}s)`,
    )
  }
  if (deadlineHit === "idle") {
    throw new Error(`LLM stream idle timeout: no events for ${Math.round(idleMs / 1000)}s`)
  }
}

async function completeWithStream(
  llm: LLMClient,
  req: { model: string; system: string; messages: LLMMessage[]; tools?: LLMToolSpec[] },
  onEvent: (event: LLMStreamEvent) => void,
  watchdog?: StreamWatchdog,
): Promise<LLMResponse> {
  const guard = llm.completeStream
  if (!guard) throw new Error("LLM does not support streaming")
  const stream = await guard(req)
  let text = ""
  let reasoning = ""
  const toolCalls = new Map<string, { id: string; name: string; input: unknown }>()
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, usageAvailable: false }
  let streamError: string | null = null

  for await (const event of withStreamWatchdog(stream, watchdog ?? {})) {
    onEvent(event)
    switch (event.kind) {
      case "text_delta":
        text += event.text
        break
      case "reasoning_start":
      case "reasoning_delta":
        reasoning += event.kind === "reasoning_delta" ? event.text : ""
        break
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
      ...(reasoning ? { reasoning } : {}),
    }
  }
  return { kind: "text", text, usage, ...(reasoning ? { reasoning } : {}) }
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

function appendAssistantText(
  session: SessionState,
  text: string,
  reasoning?: string,
): SessionState {
  const parts: MessagePart[] = []
  if (reasoning) parts.push({ type: "reasoning", text: reasoning })
  parts.push({ type: "text", text })
  return {
    ...session,
    messages: [
      ...session.messages,
      {
        id: `msg-assistant-${Date.now()}`,
        role: "assistant",
        content: text,
        parts,
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
  for (const tc of session.toolCalls) charSum += JSON.stringify(tc).length
  // Conservative estimate: ~3 chars per token for code-heavy content.
  return Math.ceil(charSum / 3)
}

function sessionHasBootstrap(session: SessionState): boolean {
  return session.messages.some(
    (m) => m.role === "user" && m.content.startsWith("[Project context:"),
  )
}
