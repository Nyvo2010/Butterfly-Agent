import type { COE, SCE, SCEOptions } from "@butterfly/context"
import { log } from "@butterfly/core"
import type { LLMClient, LLMMessage, LLMResponse, LLMToolSpec, ToolCallParser } from "@butterfly/llm"
import type { SessionState, SessionStore, Tier, ToolCallRecord } from "@butterfly/session"
import type { Tool, ToolRegistry } from "@butterfly/tools"
import { access } from "node:fs/promises"
import { resolve } from "node:path"
import { kindsForMode } from "./modes"
import { buildSystemPrompt } from "./prompt"
import type { ModelResolution, ModelRouter } from "./router"

export interface AgentLoopDeps {
  llm: LLMClient
  sce: SCE
  coe: COE
  router: ModelRouter
  registry: ToolRegistry
  store: SessionStore
  parser?: ToolCallParser
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
        response = await this.deps.llm.complete({
          model: lastResolution.model,
          system: prompt.system,
          messages: llmMessages,
          tools: llmTools.length > 0 ? llmTools : undefined,
        })
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

      // ── Step 7 + 8: Execute tool calls sequentially, append results ────
      let stepHadFailure = false
      const messages: SessionState["messages"] = [...session.messages]
      const toolCalls: ToolCallRecord[] = [...session.toolCalls]
      const fileChanges: SessionState["fileChanges"] = [...session.fileChanges]
      const readFiles: string[] = [...(session.readFiles ?? [])]

      // Store the assistant's tool-call decision as a message so the LLM
      // sees its own decision-making in subsequent iterations.  Without this
      // the conversation alternates user→tool-result→user→tool-result which
      // confuses models into calling tools indefinitely.
      //
      // Note: using a natural-language prefix instead of bracket-syntax to
      // avoid confusing Mistral's tool-call parser (some Mistral models
      // misinterpret [Tool ...] patterns as tool invocations).
      const toolCallNames = response.calls.map((c) => c.name).join(", ")
      messages.push({
        id: `msg-assistant-step-${iteration}`,
        role: "assistant",
        content: `Using tools: ${toolCallNames}`,
        timestamp: new Date().toISOString(),
      })

      for (const call of response.calls) {
        const tool = this.deps.registry.get(call.name)
        if (!tool) {
          log("warn", "agent.step.tool_unknown", { ...stepLog, name: call.name })
          stepHadFailure = true
          continue
        }
        const startedAt = new Date().toISOString()
        log("info", "agent.step.tool_start", {
          ...stepLog,
          name: call.name,
          args: call.input,
          startedAt,
        })
        let result: { kind: "ok"; output: unknown } | { kind: "err"; message: string }
        const path = String((call.input as { path?: string }).path ?? "")
        if ((tool.name === "write" || tool.name === "patch" || tool.name === "delete") && path && !readFiles.includes(path)) {
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
        if (tool.name === "read" && result.kind === "ok" && path && !readFiles.includes(path)) {
          readFiles.push(path)
        }
        const finishedAt = new Date().toISOString()
        log("info", "agent.step.tool_result", {
          ...stepLog,
          name: call.name,
          kind: result.kind,
          outputBytes: result.kind === "ok" ? JSON.stringify(result.output).length : 0,
          message: result.kind === "err" ? result.message : undefined,
          finishedAt,
        })
        if (result.kind === "err") stepHadFailure = true

        const tcId = `tc-${call.id}-${iteration}`
        toolCalls.push({
          id: tcId,
          name: call.name,
          input: call.input,
          result: result.kind === "ok" ? result.output : undefined,
          error: result.kind === "err" ? result.message : undefined,
          startedAt,
          finishedAt,
        })
        if (toolMatchesFileMutation(tool)) {
          fileChanges.push({
            path: String((call.input as { path?: string }).path ?? "?"),
            kind:
              tool.name === "delete"
                ? "delete"
                : tool.kind === "write" || tool.name === "write"
                  ? "write"
                  : "patch",
            at: finishedAt,
          })
        }
        messages.push({
          id: `msg-${call.id}-${iteration}`,
          role: "tool",
          content: toolMessageContent(result),
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
  return tool.name === "write" || tool.name === "patch" || tool.name === "delete"
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

// each subagent must satisfy the same loop, so no separate type lives here.
export type { ModelResolution }
