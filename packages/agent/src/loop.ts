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
import type { SessionState, SessionStore, Tier, ToolCallRecord } from "@butterfly/session"
import type { Tool, ToolRegistry } from "@butterfly/tools"
import { access, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { kindsForMode } from "./modes"
import { buildSystemPrompt } from "./prompt"
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
  /** Optional streaming callback for live UI updates. */
  onStreamEvent?: (event: LLMStreamEvent) => void
  /** Optional callback after each iteration with current session state. */
  onIteration?: (session: SessionState, iteration: number) => void
}

export interface RunRequest {
  session: SessionState
  query: string
  cwd: string
  maxSteps?: number
  sceOptions?: Partial<SCEOptions>
}

export type StopReason = "no_tool_calls" | "error_max_escalation" | "max_steps"

export interface RunResult {
  session: SessionState
  lastResolution: ModelResolution
  iterations: number
  stopReason: StopReason
}

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  async run(req: RunRequest): Promise<RunResult> {
    const maxSteps = req.maxSteps ?? 20
    let session = req.session

    // Prime an empty session with the user's query as the first user turn.
    // Required so the LLM's first call has a non-empty messages[] — Mistral rejects
    // empty messages arrays as "Invalid prompt: messages must not be empty" (other
    // providers silently misbehave). Idempotent: only fires when messages is empty.
    if (session.messages.length === 0) {
      session = {
        ...session,
        messages: [
          {
            id: `msg-user-query`,
            role: "user",
            content: req.query,
            timestamp: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      }
    }

    let lastResolution: ModelResolution = this.deps.router.resolve(session.tier, 0)
    let iteration = 0

    while (iteration < maxSteps) {
      const stepLog = { iteration, sessionId: session.id, mode: session.mode }

      // ── Step 1: Resolve model via Model Router ────────────────────────
      lastResolution = this.deps.router.resolve(session.tier, escalationCount(session.tier))
      log("info", "agent.step.resolve_model", {
        ...stepLog,
        tier: lastResolution.tier,
        model: lastResolution.model,
        escalationDepth: lastResolution.escalationDepth,
      })

      // ── Step 2: Run SCE ────────────────────────────────────────────────
      const slice = await this.deps.sce.select(req.query, { cwd: req.cwd, ...req.sceOptions })
      log("info", "agent.step.sce_complete", {
        ...stepLog,
        grepMatches: slice.grepMatches.length,
        fileSnippets: slice.fileSnippets.length,
        files: slice.fileSnippets.map((f) => f.path),
      })

      // ── Step 3: Run COE ────────────────────────────────────────────────
      const optimized = await this.deps.coe.optimize(session, { maxContextTokens: 8_000 })
      session = { ...optimized, updatedAt: new Date().toISOString() }
      log("info", "agent.step.coe_complete", {
        ...stepLog,
        messagesKept: session.messages.length,
        toolCallsKept: session.toolCalls.length,
        fileChanges: session.fileChanges.length,
      })

      // ── Step 4: Build prompt ───────────────────────────────────────────
      const tools = this.deps.registry.listAllowed(kindsForMode(session.mode))
      const llmTools: LLMToolSpec[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
      const prompt = buildSystemPrompt({
        mode: session.mode,
        query: req.query,
        sceSlice: slice,
        tools,
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
      const llmMessages: LLMMessage[] = session.messages.map((m) => ({
        role: m.role,
        content: m.content,
        toolCallId: m.toolCallId,
      }))
      let response: LLMResponse
      try {
        // Use streaming when both onStreamEvent and completeStream are available.
        if (this.deps.onStreamEvent && this.deps.llm.completeStream) {
          response = await completeWithStream(
            this.deps.llm,
            {
              model: lastResolution.model,
              system: prompt.system,
              messages: llmMessages,
              tools: llmTools.length > 0 ? llmTools : undefined,
            },
            this.deps.onStreamEvent,
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
        const finalSession: SessionState = appendAssistantText(session, response.text)
        await this.deps.store.save(finalSession)
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
      const readFiles: string[] = [...(session.readFiles ?? [])]

      // Store the assistant's tool-call decision as a message so the LLM
      // sees its own decision-making in subsequent iterations.
      const toolCallNames = response.calls.map((c) => c.name).join(", ")
      messages.push({
        id: `msg-assistant-step-${iteration}`,
        role: "assistant",
        content: `Using tools: ${toolCallNames}`,
        timestamp: new Date().toISOString(),
      })

      // Execute all tool calls in parallel. Each call is independent;
      // write-protection checks run first, then all tools fire concurrently.
      const callResults = await Promise.all(
        response.calls.map(async (call) => {
          const tool = this.deps.registry.get(call.name)
          if (!tool) {
            log("warn", "agent.step.tool_unknown", { ...stepLog, name: call.name })
            return { call, tool: null, error: true, result: undefined as unknown }
          }

          // Permission check for destructive tools.
          if (
            this.deps.permissionHook &&
            (tool.kind === "write" || tool.kind === "exec" || tool.kind === "delegate")
          ) {
            const perm = await this.deps.permissionHook(
              tool.name,
              call.input as Record<string, unknown>,
            )
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
                result: {
                  kind: "err" as const,
                  message: perm.reason ?? `Permission denied for ${tool.name}`,
                },
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

          const path = String((call.input as { path?: string }).path ?? "")

          // Checkpoint: save file content before mutation for rollback.
          let beforeContent: string | undefined
          if (toolMatchesFileMutation(tool) && path) {
            const resolved = path.startsWith("/") ? path : resolve(req.cwd, path)
            try {
              beforeContent = await readFile(resolved, "utf8")
            } catch {
              // File doesn't exist yet — no checkpoint needed.
            }
          }

          // Write-protection: must read a file before mutating it.
          let result: { kind: "ok"; output: unknown } | { kind: "err"; message: string }
          if (
            (tool.name === "write" || tool.name === "patch" || tool.name === "delete" || tool.name === "diff_patch") &&
            path &&
            !readFiles.includes(path)
          ) {
            const resolved = path.startsWith("/") ? path : resolve(req.cwd, path)
            try {
              await access(resolved)
              result = { kind: "err", message: `File not read yet. Use read tool first: ${path}` }
            } catch {
              result = await tool.execute(call.input as Record<string, unknown>, { cwd: req.cwd })
            }
          } else {
            result = await tool.execute(call.input as Record<string, unknown>, { cwd: req.cwd })
          }

          // Track read files.
          if (tool.name === "read" && result.kind === "ok" && path) {
            return {
              call,
              tool,
              error: false,
              result,
              startedAt,
              readPath: path,
              beforeContent: undefined,
            }
          }

          return { call, tool, error: result.kind === "err", result, startedAt, beforeContent, readPath: undefined as string | undefined }
        }),
      )

      // Collect results in order.
      for (const cr of callResults) {
        const { call, tool, error, result: res, startedAt, beforeContent, readPath } = cr

        if (!tool || !res) {
          stepHadFailure = stepHadFailure || error
          continue
        }

        const finishedAt = new Date().toISOString()
        log("info", "agent.step.tool_result", {
          ...stepLog,
          name: call.name,
          kind: res.kind,
          outputBytes: res.kind === "ok" ? JSON.stringify(res.output).length : 0,
          message: res.kind === "err" ? res.message : undefined,
          finishedAt,
        })
        if (res.kind === "err") stepHadFailure = true

        if (readPath && !readFiles.includes(readPath)) {
          readFiles.push(readPath)
        }

        const tcId = `tc-${call.id}-${iteration}`
        toolCalls.push({
          id: tcId,
          name: call.name,
          input: call.input,
          result: res.kind === "ok" ? res.output : undefined,
          error: res.kind === "err" ? res.message : undefined,
          startedAt: startedAt ?? finishedAt,
          finishedAt,
        })

        if (toolMatchesFileMutation(tool)) {
          const fPath = String((call.input as { path?: string }).path ?? "?")
          const kind =
            tool.name === "delete"
              ? "delete"
              : tool.name === "diff_patch"
                ? "patch"
                : tool.kind === "write" || tool.name === "write"
                  ? "write"
                  : "patch"
          // Read after-content for checkpoint.
          let afterContent: string | undefined
          if (res.kind === "ok" && tool.name !== "delete" && fPath !== "?") {
            const resolved = fPath.startsWith("/") ? fPath : resolve(req.cwd, fPath)
            try {
              afterContent = await readFile(resolved, "utf8")
            } catch {
              // File may have been created — that's fine.
            }
          }
          fileChanges.push({
            path: fPath,
            kind,
            before: beforeContent,
            after: afterContent,
            at: finishedAt,
          })
        }

        messages.push({
          id: `msg-${call.id}-${iteration}`,
          role: "tool",
          content: toolMessageContent(res),
          toolCallId: call.id,
          timestamp: finishedAt,
        })
      }

      session = {
        ...session,
        messages,
        toolCalls,
        fileChanges,
        readFiles,
        updatedAt: new Date().toISOString(),
      }
      await this.deps.store.save(session)
      // Notify listeners so rollback tool and other consumers see live session state.
      this.deps.onIteration?.(session, iteration)
      log("info", "agent.step.iteration_appended", {
        ...stepLog,
        newMessageCount: session.messages.length,
        newToolCallCount: session.toolCalls.length,
        stepHadFailure,
      })

      // ── Step 9: Loop. Escalate on step failure if at least one tool errored. ──
      if (stepHadFailure && session.tier !== "escalate") {
        const escalated = this.deps.router.escalate(session.tier, escalationCount(session.tier))
        session = { ...session, tier: escalated.tier }
        if (escalated.capped) {
          log("error", "agent.stop.escalation_capped", { ...stepLog, tier: session.tier })
          await this.deps.store.save(session)
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
    await this.deps.store.save(session)
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
  const stream = await llm.completeStream!(req)
  let text = ""
  const toolCalls = new Map<string, { id: string; name: string; input: unknown }>()
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  for await (const event of stream) {
    onEvent(event)
    switch (event.kind) {
      case "text_delta":
        text += event.text
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
    }
  }

  if (toolCalls.size > 0) {
    return {
      kind: "tool_calls",
      calls: Array.from(toolCalls.values()).map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: tc.input as Record<string, unknown> ?? {},
      })),
      usage,
    }
  }
  return { kind: "text", text, usage }
}

function escalationCount(tier: Tier): number {
  // depth is encoded in the tier itself for MVP simplicity (no sticky-history field needed).
  return tier === "trivial" ? 0 : tier === "standard" ? 1 : tier === "complex" ? 2 : 3
}

function toolMessageContent(
  result: { kind: "ok"; output: unknown } | { kind: "err"; message: string },
): string {
  if (result.kind === "ok") {
    if (typeof result.output === "string") return result.output
    return JSON.stringify(result.output)
  }
  return `ERROR: ${result.message}`
}

function toolMatchesFileMutation(tool: Tool): boolean {
  return tool.name === "write" || tool.name === "patch" || tool.name === "delete" || tool.name === "diff_patch"
}

function appendAssistantText(session: SessionState, text: string): SessionState {
  return {
    ...session,
    messages: [
      ...session.messages,
      {
        id: `msg-assistant-final`,
        role: "assistant",
        content: text,
        timestamp: new Date().toISOString(),
      },
    ],
    updatedAt: new Date().toISOString(),
  }
}
