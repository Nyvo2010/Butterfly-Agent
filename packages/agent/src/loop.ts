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
  ToolCallParser,
} from "@butterfly/llm"
import type { SessionState, SessionStore, ToolCallRecord } from "@butterfly/session"
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

export interface AgentLoopDeps {
  llm: LLMClient
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
   * Optional callback to ask the user a question (human-in-the-loop).
   * Mirrors OpenCode's question tool pattern. When set, the ask_user tool
   * can pause execution to solicit user input.
   */
  onAskUser?: (question: string, options?: string[]) => Promise<string | null>
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

export interface RunResult {
  session: SessionState
  lastResolution: ModelResolution
  iterations: number
  stopReason: StopReason
}

const MAX_MESSAGES = 200

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

// ── Agent Loop ───────────────────────────────────────────────────────────────

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  /**
   * Save session to store, returning whether the save succeeded.
   * Logs failures but does not throw — callers should check the return
   * value to detect persistent storage failures.
   */
  private async saveSession(session: SessionState): Promise<boolean> {
    try {
      await this.deps.store.save(session)
      return true
    } catch (e) {
      log("error", "agent.step.save_failed", { error: (e as Error).message })
      return false
    }
  }

  async run(req: RunRequest): Promise<RunResult> {
    if (!req.query?.trim()) throw new Error("query is required")
    const maxSteps = req.maxSteps ?? 20
    const maxContextTokens = req.maxContextTokens ?? 8_000
    const toolMessageMaxTokens = req.toolMessageMaxTokens
    const workspaceRoots = req.workspaceRoots ?? [req.cwd]
    let session = req.session
    let consecutiveSaveFailures = 0
    const MAX_CONSECUTIVE_SAVE_FAILURES = 3

    // Prime an empty session with the user's query as the first user turn.
    // Required so the LLM's first call has a non-empty messages[] — Mistral rejects
    // empty messages arrays as "Invalid prompt: messages must not be empty" (other
    // providers silently misbehave). Idempotent: only fires when messages is empty.
    if (session.messages.length === 0) {
      // Inject bootstrap as a prefix to the first user message so it appears
      // once rather than in every system prompt iteration.
      const bootstrapPrefix = req.bootstrapSummary
        ? `[Project context: ${req.bootstrapSummary}]\n\n`
        : ""
      session = {
        ...session,
        messages: [
          {
            id: `msg-user-query`,
            role: "user",
            content: `${bootstrapPrefix}${req.query}`,
            timestamp: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      }
    } else if (req.bootstrapSummary && !sessionHasBootstrap(session)) {
      // Session resume: inject bootstrap into the first user message if not
      // already present. Build a new message object to avoid mutating the
      // caller's session reference.
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

    let lastResolution: ModelResolution = this.deps.router.resolve(session.tier, 0)
    let iteration = 0
    let escalationDepth = 0

    while (iteration < maxSteps) {
      const stepLog = { iteration, sessionId: session.id, mode: session.mode }

      // ── Step 1: Resolve model via Model Router ────────────────────────
      lastResolution = this.deps.router.resolve(session.tier, escalationDepth)
      log("info", "agent.step.resolve_model", {
        ...stepLog,
        tier: lastResolution.tier,
        model: lastResolution.model,
        escalationDepth: lastResolution.escalationDepth,
      })

      // ── Step 2: Run SCE ────────────────────────────────────────────────
      // Use an adaptive query: start with the user's task, then switch to
      // the latest assistant response to find context relevant to current work.
      // Skip the SCE cache when files were mutated in a previous iteration
      // so the context reflects the agent's actual progress.
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

      // ── Step 3: Run COE ────────────────────────────────────────────────
      // Trigger COE when total estimated tokens exceed 70% of the context
      // budget. Uses a fast char-length heuristic (~4 chars/token) to avoid
      // the overhead of calling the real tokenizer on every message.
      const estimatedTokens = estimateTotalTokens(session)
      if (estimatedTokens > maxContextTokens * 0.7) {
        const optimized = await this.deps.coe.optimize(session, {
          maxContextTokens,
          ...(toolMessageMaxTokens !== undefined ? { toolMessageMaxTokens } : {}),
        })
        session = { ...optimized, updatedAt: new Date().toISOString() }
      }
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

      // ── Step 4: Build prompt ───────────────────────────────────────────
      const tools = this.deps.registry.listAllowed(kindsForMode(session.mode))
      const llmTools: LLMToolSpec[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
      const toolMetas = tools.map((t) => ({
        name: t.name,
        kind: t.kind,
        description: t.description,
      }))
      const prompt = buildSystemPrompt({
        mode: session.mode,
        query: req.query,
        sceSlice: slice,
        tools: toolMetas,
        plan: req.plan,
        // Include tool list in prompt only when using a parser-based LLM
        // that outputs tool calls as text rather than natively via API.
        includeToolList: this.deps.parser !== undefined,
      })
      log("info", "agent.step.build_prompt", {
        ...stepLog,
        mode: session.mode,
        toolCount: llmTools.length,
        systemPromptChars: prompt.system.length,
        toolListChars: prompt.toolList.length,
        contextChars: prompt.codeContext.length,
      })

      // ── Step 5: Call LLM ───────────────────────────────────────────────
      const llmMessages: LLMMessage[] = session.messages.map((m) => {
        if (m.role === "tool") return { role: "tool", content: m.content, toolCallId: m.toolCallId }
        if (m.role === "system") return { role: "system", content: m.content }
        if (m.role === "user") return { role: "user", content: m.content }
        return { role: "assistant", content: m.content }
      })
      let response: LLMResponse
      try {
        // Streaming-first: prefer streaming when available for live UX.
        // Falls back to non-streaming when completeStream is unavailable.
        const useStreaming = this.deps.llm.completeStream !== undefined
        if (useStreaming) {
          response = await completeWithStream(
            this.deps.llm,
            {
              model: lastResolution.model,
              system: prompt.system,
              messages: llmMessages,
              tools: llmTools.length > 0 ? llmTools : undefined,
            },
            this.deps.onStreamEvent ?? (() => {}),
          )
        } else {
          response = await this.deps.llm.complete({
            model: lastResolution.model,
            system: prompt.system,
            messages: llmMessages,
            tools: llmTools.length > 0 ? llmTools : undefined,
          })
        }
      } catch (err) {
        log("error", "agent.step.llm_error", { ...stepLog, error: (err as Error).message })
        await this.saveSession(session)
        throw err
      }
      log("info", "agent.step.llm_response", {
        ...stepLog,
        kind: response.kind,
        usage: response.usage,
        callCount: response.kind === "tool_calls" ? response.calls.length : 0,
      })

      // ── Step 6: Parse response ─────────────────────────────────────────

      // ── Step 6b: Try to parse text response as tool calls ──────────────────
      if (response.kind === "text" && this.deps.parser) {
        const parsed = this.deps.parser.parse(response.text)
        if (parsed && parsed.length > 0) {
          response = { kind: "tool_calls", calls: parsed, usage: response.usage }
        }
      }

      if (response.kind === "text") {
        log("info", "agent.stop.no_tool_calls", {
          ...stepLog,
          finalTextChars: response.text.length,
        })

        // If no plan exists and the response looks like a plan, extract it
        // and continue the loop so the model can work through its own plan.
        // Only do this if there are steps remaining — don't waste the last step.
        if (!req.plan && looksLikePlan(response.text) && iteration + 1 < maxSteps) {
          const extracted = extractPlanFromText(response.text, req.query.slice(0, 200))
          if (extracted.todos.length > 0) {
            req.plan = extracted
            log("info", "agent.plan.extracted_and_continue", {
              todos: extracted.todos.length,
              goal: extracted.goal,
            })
            // Append a short summary so the conversation flow is preserved.
            // Don't append the full plan text (it's in the system prompt),
            // but include the first line so the model has a breadcrumb.
            const firstLine = response.text.split("\n")[0]?.slice(0, 120) ?? ""
            session = appendAssistantText(session, `Plan created: ${firstLine}`)
            await this.saveSession(session)
            iteration++
            continue
          }
        }

        const finalSession: SessionState = appendAssistantText(session, response.text)
        await this.saveSession(finalSession)
        return {
          session: finalSession,
          lastResolution,
          iterations: iteration + 1,
          stopReason: "no_tool_calls",
        }
      }

      // ── Step 7 + 8: Execute tool calls in parallel, append results ────
      let stepHadFailure = false
      const messages: SessionState["messages"] = [...session.messages]
      const toolCalls: ToolCallRecord[] = [...session.toolCalls]
      const fileChanges: SessionState["fileChanges"] = [...session.fileChanges]
      const readFiles: Set<string> = new Set(session.readFiles)

      // Store the assistant's tool-call decision as a message so the LLM
      // sees its own decision-making in subsequent iterations.
      // The toolCallId on the assistant message allows COE to group tool
      // results with their parent call without relying on string patterns.
      const assistantToolCallId = `atc-${iteration}`
      const toolCallNames = response.calls.map((c) => c.name).join(", ")
      messages.push({
        id: `msg-assistant-step-${iteration}`,
        role: "assistant",
        content: `Using tools: ${toolCallNames}`,
        timestamp: new Date().toISOString(),
        toolCallId: assistantToolCallId,
      })

      // Execute all tool calls. For correctness, each tool call's
      // write-protection check must see up-to-date readFiles state.
      // We execute sequentially (not Promise.all) to avoid TOCTOU races
      // where a read and write to the same file run simultaneously.
      const callResults: Array<{
        call: { id: string; name: string; input: unknown }
        tool: import("@butterfly/tools").Tool | null
        error: boolean
        result?: { kind: "ok"; output: unknown } | { kind: "err"; message: string }
        startedAt?: string
        finishedAt?: string
        readPath?: string
        beforeContent?: string
      }> = []

      for (const call of response.calls) {
        const tool = this.deps.registry.get(call.name)
        if (!tool) {
          log("warn", "agent.step.tool_unknown", { ...stepLog, name: call.name })
          callResults.push({ call, tool: null, error: true })
          continue
        }

        // Permission check for destructive tools.
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
            callResults.push({
              call,
              tool,
              error: true,
              result: {
                kind: "err" as const,
                message: perm.reason ?? `Permission denied for ${tool.name}`,
              },
            })
            continue
          }
        }

        // Quality check: validate tool call input before execution.
        // Blocks error-severity issues (null path, dangerous commands).
        // Warns on warn-severity issues (empty content, no-op patches).
        if (this.deps.qualityMonitor) {
          const qc = this.deps.qualityMonitor.check(tool, asRecord(call.input))
          this.deps.qualityMonitor.logIssues(call.name, qc)
          if (!qc.valid && qc.severity === "error") {
            callResults.push({
              call,
              tool,
              error: true,
              result: {
                kind: "err" as const,
                message: `Quality check failed: ${qc.issues.join("; ")}`,
              },
            })
            continue
          }
        }

        const startedAt = new Date().toISOString()
        log("info", "agent.step.tool_start", {
          ...stepLog,
          name: call.name,
          args: call.input,
          startedAt,
        })

        const rawPath = getInputPath(call.input)
        const path = rawPath ? normalizePath(rawPath, req.cwd) : ""

        // Checkpoint: save file content before mutation for rollback.
        let beforeContent: string | undefined
        if (toolMatchesFileMutation(tool) && path) {
          try {
            beforeContent = await readFile(path, "utf8")
          } catch {
            // File doesn't exist yet — no checkpoint needed.
          }
        }

        // Write-protection: must read a file before mutating it.
        // Check both file tools AND bash/exec tools since those can also mutate files.
        let result: { kind: "ok"; output: unknown } | { kind: "err"; message: string }
        const isMutationTool = tool.kind === "write" || tool.kind === "exec"

        if (isMutationTool) {
          if (path) {
            // File tools with a path field need read-before-write protection.
            // Check readFiles first: if the file was already read this session, allow mutation.
            // Otherwise, check if the file exists on disk — existing unread files are blocked,
            // while new (non-existent) files are allowed for creation.
            if (readFiles.has(path)) {
              result = await tool.execute(asRecord(call.input), {
                cwd: req.cwd,
                onAskUser: this.deps.onAskUser,
                workspaceRoots,
              })
            } else {
              try {
                await access(path)
                result = {
                  kind: "err",
                  message: `File not read yet. Use read tool first: ${rawPath}`,
                }
              } catch {
                result = await tool.execute(asRecord(call.input), {
                  cwd: req.cwd,
                  onAskUser: this.deps.onAskUser,
                  workspaceRoots,
                })
              }
            }
          } else {
            // Tools without path (e.g., bash/exec) can mutate files.
            // Add a simple check for destructive patterns to warn/block them.
            if (isShellLikeTool(tool.name)) {
              const command = String((call.input as Record<string, unknown>).command ?? "")
              if (!isCommandSafe(command)) {
                result = {
                  kind: "err",
                  message: "Command contains dangerous patterns and was blocked.",
                }
              } else {
                result = await tool.execute(asRecord(call.input), {
                  cwd: req.cwd,
                  onAskUser: this.deps.onAskUser,
                  workspaceRoots,
                })
              }
            } else {
              // Other mutation tools without path - allow but log warning.
              log("warn", "agent.tool.no_path", { tool: tool.name, input: call.input })
              result = await tool.execute(asRecord(call.input), {
                cwd: req.cwd,
                onAskUser: this.deps.onAskUser,
                workspaceRoots,
              })
            }
          }
        } else {
          result = await tool.execute(asRecord(call.input), {
            cwd: req.cwd,
            onAskUser: this.deps.onAskUser,
            workspaceRoots,
          })
        }

        // Track read files immediately so subsequent tool calls see the update.
        if (isReadTool(tool.name) && result.kind === "ok" && path) {
          readFiles.add(path)
        }

        const finishedAt = new Date().toISOString()
        callResults.push({
          call,
          tool,
          error: result.kind === "err",
          result,
          startedAt,
          finishedAt,
          beforeContent,
          readPath: isReadTool(tool.name) ? path : undefined,
        })
      }

      // Collect results in order.
      for (const cr of callResults) {
        const {
          call,
          tool,
          error,
          result: res,
          startedAt,
          finishedAt,
          beforeContent,
          readPath,
        } = cr

        if (!tool || !res) {
          stepHadFailure = stepHadFailure || error
          continue
        }

        log("info", "agent.step.tool_result", {
          ...stepLog,
          name: call.name,
          kind: res.kind,
          outputBytes: res.kind === "ok" ? JSON.stringify(res.output).length : 0,
          message: res.kind === "err" ? res.message : undefined,
          finishedAt,
        })
        if (res.kind === "err") stepHadFailure = true

        if (readPath) {
          readFiles.add(readPath)
        }

        const tcId = `tc-${call.id}-${iteration}`
        toolCalls.push({
          id: tcId,
          name: call.name,
          input: call.input,
          result: res.kind === "ok" ? res.output : undefined,
          error: res.kind === "err" ? res.message : undefined,
          startedAt: startedAt ?? finishedAt ?? new Date().toISOString(),
          finishedAt: finishedAt ?? new Date().toISOString(),
        }) // Only record file changes for SUCCESSFUL mutations.
        // Failed tool executions should not appear in the audit trail.
        if (toolMatchesFileMutation(tool) && res?.kind === "ok") {
          const fPath = getInputPath(call.input) || "?"
          const kind = isDeleteTool(tool.name)
            ? "delete"
            : isDiffPatchTool(tool.name)
              ? "patch"
              : tool.kind === "write" || tool.name === "write"
                ? "write"
                : "patch"
          // Read after-content for checkpoint.
          let afterContent: string | undefined
          if (!isDeleteTool(tool.name) && fPath !== "?") {
            const absPath = normalizePath(fPath, req.cwd)
            try {
              afterContent = await readFile(absPath, "utf8")
            } catch {
              // File may have been created — that's fine.
            }
          }
          fileChanges.push({
            path: fPath,
            kind,
            before: beforeContent,
            after: afterContent,
            at: finishedAt ?? new Date().toISOString(),
          })
        }

        messages.push({
          id: `msg-${call.id}-${iteration}`,
          role: "tool",
          content: toolMessageContent(res),
          toolCallId: call.id,
          timestamp: finishedAt ?? new Date().toISOString(),
        })
      }

      session = {
        ...session,
        messages,
        toolCalls,
        fileChanges,
        readFiles: Array.from(readFiles),
        updatedAt: new Date().toISOString(),
      }
      const saved = await this.saveSession(session)
      if (!saved) {
        consecutiveSaveFailures++
        if (consecutiveSaveFailures >= MAX_CONSECUTIVE_SAVE_FAILURES) {
          log("error", "agent.stop.save_failure", {
            consecutiveFailures: consecutiveSaveFailures,
            max: MAX_CONSECUTIVE_SAVE_FAILURES,
          })
          return {
            session,
            lastResolution,
            iterations: iteration + 1,
            stopReason: "save_failure",
          }
        }
      } else {
        consecutiveSaveFailures = 0
      }
      // Notify listeners so rollback tool and other consumers see live session state.
      this.deps.onIteration?.(session, iteration)
      log("info", "agent.step.iteration_appended", {
        ...stepLog,
        newMessageCount: session.messages.length,
        newToolCallCount: session.toolCalls.length,
        stepHadFailure,
      })

      // ── Step 9: Loop. Escalate on step failure if at least one tool errored. ──
      // Also update the plan with auto-completion heuristics (mutations only).
      // Also try to extract a plan from tool-call responses that look like plans.
      if (!req.plan && callResults.length > 0) {
        // Check if any tool result contains a plan-like response.
        for (const cr of callResults) {
          const text =
            cr.result?.kind === "ok" && typeof cr.result.output === "string" ? cr.result.output : ""
          if (text && looksLikePlan(text)) {
            const extracted = extractPlanFromText(text, req.query.slice(0, 200))
            if (extracted.todos.length > 0) {
              req.plan = extracted
              log("info", "agent.plan.extracted_from_tools", {
                todos: extracted.todos.length,
              })
              break
            }
          }
        }
      }
      if (req.plan && !stepHadFailure) {
        for (const cr of callResults) {
          if (cr.result?.kind === "ok" && cr.tool) {
            // Only auto-complete on actual mutations, not reads.
            if (toolMatchesFileMutation(cr.tool) || isSubagentTool(cr.call.name)) {
              req.plan = updatePlanFromToolResult(
                req.plan,
                cr.call.name,
                asRecord(cr.call.input),
                true,
              )
            }
          }
        }
      }

      // ── Check for abort signal between iterations ────────────────────
      if (req.signal?.aborted) {
        log("info", "agent.stop.aborted", { ...stepLog })
        await this.saveSession(session)
        return {
          session,
          lastResolution,
          iterations: iteration + 1,
          stopReason: "no_tool_calls",
        }
      }

      if (stepHadFailure) {
        const escalated = this.deps.router.escalate(session.tier, escalationDepth)
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
}

/**
 * Consume a streamed completion and build a full LLMResponse.
 * Calls onStreamEvent for each chunk so the CLI can show live output.
 */
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
        // Reasoning blocks are passed through to the UI via onStreamEvent.
        // They do not contribute to the final response text or tool calls.
        break
      case "tool_call_delta": {
        const existing = toolCalls.get(event.id) ?? { id: event.id, name: "", input: undefined }
        if (event.name) existing.name = event.name
        // Vercel SDK emits the latest full args object in each tool-call delta.
        // Use the last value (not concatenation) to avoid stringifying objects.
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
  // If the stream yielded an error after partial output, surface it.
  if (streamError) {
    throw new Error(`LLM stream error: ${streamError}`)
  }

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
    if (typeof result.output === "string") return result.output
    return JSON.stringify(result.output)
  }
  return `ERROR: ${result.message.slice(0, 1000)}`
}

function getInputPath(input: unknown): string {
  if (typeof input !== "object" || !input) return ""
  const obj = input as Record<string, unknown>
  if (typeof obj.path !== "string") return ""
  return obj.path
}

/** Normalize a tool input path to an absolute path for consistent readFiles lookups. */
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

/**
 * Build an adaptive SCE query that evolves with the agent's progress.
 * Uses the latest assistant message and recent tool results as context
 * for what to search for, falling back to the original query when there's
 * no substantive response yet.
 */
function buildSCEQuery(
  messages: Array<{ role: string; content: string }>,
  originalQuery: string,
): string {
  // Walk backwards to find the latest assistant or tool message with substance.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (
      m.role === "assistant" &&
      m.content.length > 50 &&
      !isIntermediateAssistantMessage(m.content)
    ) {
      const snippet = m.content.slice(0, 300)
      return `${originalQuery.slice(0, 200)} | ${snippet}`
    }
    // Also consider recent tool messages for context (e.g., grep results).
    if (m.role === "tool" && m.content.length > 100) {
      const snippet = m.content.slice(0, 200)
      return `${originalQuery.slice(0, 200)} | ${snippet}`
    }
  }
  return originalQuery
}

/**
 * Heuristic: does this text look like a plan/task-list?
 * Detects markdown checkboxes and numbered lists with task-like language.
 */
function looksLikePlan(text: string): boolean {
  if (text.length < 50) return false
  const checkboxCount = (text.match(/^[-*]\s+\[[ xX]\]/gm) ?? []).length
  if (checkboxCount >= 2) return true
  const numListCount = (text.match(/^\d+\.\s+/gm) ?? []).length
  return numListCount >= 3
}

/**
 * Fast token estimation for the COE threshold pre-check.
 * Uses char-length / 4 as a rough heuristic (English text averages
 * ~4 characters per token). COE's optimize() method uses the real
 * tokenizer internally for accurate truncation when it runs.
 */
function estimateTotalTokens(session: SessionState): number {
  let charSum = 0
  for (const m of session.messages) {
    charSum += m.content.length
  }
  return Math.ceil(charSum / 4)
}

/** Check if a session already has bootstrap context injected. */
function sessionHasBootstrap(session: SessionState): boolean {
  return session.messages.some(
    (m) => m.role === "user" && m.content.startsWith("[Project context:"),
  )
}
