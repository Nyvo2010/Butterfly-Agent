/**
 * Butterfly ACP Agent — wraps Butterfly's AgentLoop in an ACP-compatible agent.
 *
 * Uses the @agentclientprotocol/sdk's AgentSideConnection class.
 * Any ACP-compatible client (CLI, TUI, IDE, web) can connect.
 *
 * Protocol: JSON-RPC 2.0 over ndjson stream (stdio).
 *
 * Usage:
 *   import { ndJsonStream, AgentSideConnection } from "@agentclientprotocol/sdk"
 *   import { createButterflyACP } from "@butterfly/acp"
 *
 *   const stream = ndJsonStream(process.stdin, process.stdout)
 *   new AgentSideConnection((conn) => createButterflyACP(conn), stream)
 */

import type { Agent, AgentSideConnection } from "@agentclientprotocol/sdk"
import type { AgentFactoryResult } from "@butterfly/agent"
import { log } from "@butterfly/core"
import { ServerApp } from "@butterfly/server"
import type { SessionState } from "@butterfly/session"

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Send a text chunk to the ACP client via sessionUpdate.
 * The casts are necessary because the ACP SDK's `SessionNotification`
 * is a complex union type whose exact shape varies across SDK versions.
 * Isolating the casts here keeps the rest of the code type-safe.
 *
 * Note: `noExplicitAny` is disabled for this package in biome.json
 * because the ACP SDK inherently requires type casts.
 */
function sendStreamChunk(
  connection: AgentSideConnection,
  sessionId: string,
  text: string,
): Promise<any> {
  return connection.sessionUpdate({
    sessionId,
    update: { agentMessage: { chunks: [{ type: "text", text }] } },
  } as any)
}

// ─── ACP Agent Implementation ────────────────────────────────────────────────

interface ACPSession {
  session: SessionState
  cwd: string
  mode: "plan" | "build"
}

export interface ButterflyACPOptions {
  cwd?: string
}

/**
 * Create a Butterfly Agent that implements the ACP Agent interface.
 *
 * Use with AgentSideConnection:
 *   const stream = ndJsonStream(process.stdin, process.stdout)
 *   new AgentSideConnection((conn) => createButterflyACP(conn), stream)
 */
export function createButterflyACP(
  connection?: AgentSideConnection,
  options?: ButterflyACPOptions,
): Agent {
  const cwd = options?.cwd ?? process.cwd()

  // Use the shared ServerApp core — eliminates bootstrap duplication with
  // the HTTP server. Both transports now share config, tokenizer, store, llm,
  // bus, session-manager, and run-state.
  const app = new ServerApp({ cwd })

  // Lazy-init the agent factory on first use (createAgent is async).
  // Clear the promise on failure so subsequent calls can retry.
  let agentPromise: Promise<AgentFactoryResult> | null = null
  const getAgent = (): Promise<AgentFactoryResult> => {
    if (!agentPromise) {
      agentPromise = app.createAgent().catch((err) => {
        agentPromise = null
        throw err
      })
    }
    return agentPromise
  }

  // Session store
  const sessions = new Map<string, ACPSession>()

  return {
    // ── initialize ────────────────────────────────────────────────────
    async initialize() {
      log("info", "acp.initialize")
      return {
        protocolVersion: 1,
        capabilities: { tools: true, streaming: true },
        serverInfo: { name: "butterfly", version: "0.1.0" },
      }
    },

    // ── newSession ────────────────────────────────────────────────────
    async newSession(params) {
      // Use the shared SessionManager so the session is persisted and a
      // session.created event is emitted — consistent with the HTTP path.
      const session = await app.sessionManager.create({ mode: "build" })
      sessions.set(session.id, { session, cwd: params.cwd ?? cwd, mode: "build" })
      log("info", "acp.new_session", { sessionId: session.id, cwd: params.cwd })
      return { sessionId: session.id }
    },

    // ── loadSession (optional) ────────────────────────────────────────
    async loadSession(params) {
      const existing = await app.sessionManager.load(params.sessionId)
      if (!existing) {
        throw new Error(`Session not found: ${params.sessionId}`)
      }
      sessions.set(existing.id, {
        session: existing,
        cwd: params.cwd ?? cwd,
        mode: existing.mode,
      })
      log("info", "acp.load_session", { sessionId: existing.id })
      return {}
    },

    // ── setSessionMode ────────────────────────────────────────────────
    async setSessionMode(params) {
      const acpSession = sessions.get(params.sessionId)
      if (acpSession) {
        const mode = params.modeId as "plan" | "build"
        acpSession.mode = mode
        acpSession.session = { ...acpSession.session, mode }
      }
    },

    // ── prompt ────────────────────────────────────────────────────────
    async prompt(params) {
      const sessionId = params.sessionId
      let acpSession = sessions.get(sessionId)

      if (!acpSession) {
        // Use the shared SessionManager for persistence + event emission.
        const session = await app.sessionManager.create({
          mode: "build",
          id: sessionId ?? undefined,
        })
        acpSession = { session, cwd, mode: "build" }
        sessions.set(session.id, acpSession)
      }

      // The ACP SDK's prompt params shape varies; use a narrow accessor type.
      interface PromptParams {
        prompt?: unknown
      }
      const query =
        typeof params.prompt === "string"
          ? params.prompt
          : (((params as PromptParams).prompt as string | undefined) ?? "")
      if (typeof query !== "string" || !query.trim()) {
        return { stopReason: "end_turn" }
      }

      log("info", "acp.prompt", { sessionId: acpSession.session.id, query: query.slice(0, 200) })

      try {
        const sceOpts = app.butterflyConfig.butterfly?.sce
        const coeOpts = app.butterflyConfig.butterfly?.coe

        const agent = await getAgent()

        // Create a streaming agent loop that reports via sessionUpdate
        const streamEnabled = process.env.ACP_STREAM !== "false"

        const result = await agent.loop.run({
          session: acpSession.session,
          query,
          cwd: acpSession.cwd,
          maxSteps: app.butterflyConfig.butterfly?.maxSteps ?? 20,
          maxContextTokens: coeOpts?.maxContextTokens ?? 8000,
          toolMessageMaxTokens: coeOpts?.toolMessageMaxTokens,
          sceOptions: sceOpts
            ? {
                maxFiles: sceOpts.maxFiles,
                maxTokensPerFile: sceOpts.maxTokensPerFile,
                maxGrepResults: sceOpts.maxGrepResults,
                topFiles: sceOpts.topFiles,
              }
            : undefined,
          bootstrapSummary: agent.bootstrapSummary || undefined,
        })

        // Update stored session for multi-turn (via the shared session manager)
        await app.sessionManager.save(result.session)
        acpSession.session = result.session
        sessions.set(result.session.id, acpSession)

        // Send final message content via sessionUpdate
        const finalMessages = result.session.messages
          .filter((m) => m.role === "assistant")
          .slice(-3) // last 3 assistant messages

        if (connection && streamEnabled) {
          for (const msg of finalMessages) {
            try {
              await sendStreamChunk(connection, result.session.id, msg.content)
            } catch {
              // Best-effort streaming.
            }
          }
        }

        log("info", "acp.prompt_complete", {
          iterations: result.iterations,
          stopReason: result.stopReason,
        })

        return {
          stopReason: "end_turn",
        }
      } catch (err) {
        log("error", "acp.prompt_error", { error: (err as Error).message })
        return { stopReason: "end_turn" }
      }
    },

    // ── authenticate (optional) ───────────────────────────────────────
    async authenticate(_params) {
      // No authentication required — accept all
      log("info", "acp.authenticate")
      return {}
    },

    // ── cancel ────────────────────────────────────────────────────────
    async cancel(_params) {
      log("info", "acp.cancel")
    },
  }
}
