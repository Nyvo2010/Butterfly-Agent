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
import { ServerApp, validateApiKey } from "@butterfly/server"
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

const MAX_SESSIONS = 50

interface ACPSession {
  session: SessionState
  cwd: string
  mode: "plan" | "build"
  abortController: AbortController
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

  // Session store with bounded size.
  const sessions = new Map<string, ACPSession>()

  /** Evict oldest session when the map exceeds MAX_SESSIONS. */
  function evictOldest(): void {
    if (sessions.size <= MAX_SESSIONS) return
    let oldestId: string | null = null
    let oldestTime = ""
    for (const [id, s] of sessions) {
      if (!oldestId || s.session.updatedAt < oldestTime) {
        oldestId = id
        oldestTime = s.session.updatedAt
      }
    }
    if (oldestId) {
      // Abort any in-flight operation before evicting.
      const evicted = sessions.get(oldestId)
      if (evicted) {
        try {
          evicted.abortController.abort()
        } catch {
          /* ignore */
        }
      }
      sessions.delete(oldestId)
    }
  }

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
      sessions.set(session.id, {
        session,
        cwd: params.cwd ?? cwd,
        mode: "build",
        abortController: new AbortController(),
      })
      evictOldest()
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
        abortController: new AbortController(),
      })
      evictOldest()
      log("info", "acp.load_session", { sessionId: existing.id })
      return {}
    },

    // ── setSessionMode ────────────────────────────────────────────────
    async setSessionMode(params) {
      const acpSession = sessions.get(params.sessionId)
      if (!acpSession) throw new Error(`Session not found: ${params.sessionId}`)
      const mode = params.modeId
      if (mode !== "plan" && mode !== "build") {
        throw new Error(`Invalid mode: ${mode}. Must be "plan" or "build".`)
      }
      acpSession.mode = mode
      acpSession.session = { ...acpSession.session, mode }
      // Persist the mode change.
      await app.sessionManager.save(acpSession.session)
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
        acpSession = { session, cwd, mode: "build", abortController: new AbortController() }
        evictOldest()
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

        // Model-aware context budget: explicit config wins, otherwise derive
        // from the session model's catalog context window (fallback 8000).
        const selectedModel =
          acpSession.session.selectedModel && acpSession.session.selectedModel !== "auto"
            ? acpSession.session.selectedModel
            : (app.butterflyConfig.model ?? "")
        const maxContextTokens =
          coeOpts?.maxContextTokens ??
          (selectedModel ? await app.providerService.contextBudgetFor(selectedModel, 8000) : 8000)

        const result = await agent.loop.run({
          session: acpSession.session,
          query,
          cwd: acpSession.cwd,
          maxSteps: app.butterflyConfig.butterfly?.maxSteps ?? 20,
          maxContextTokens,
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
          signal: acpSession.abortController.signal,
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
        // Send error as a stream chunk so the client can display it.
        if (connection) {
          try {
            await sendStreamChunk(
              connection,
              acpSession?.session?.id ?? sessionId,
              `Error: ${(err as Error).message}`,
            )
          } catch {
            /* best-effort */
          }
        }
        return { stopReason: "end_turn" }
      }
    },

    // ── authenticate (optional) ───────────────────────────────────────
    async authenticate(params) {
      // When auth is enabled on the server, validate the client's auth params.
      if (app.authConfig.enabled && app.authConfig.apiKey) {
        // The ACP client may send auth params in various shapes.
        // Check for common patterns: apiKey, token, or bearerToken fields.
        const authParams = params as unknown as Record<string, unknown>
        const clientToken =
          (authParams.apiKey as string) ??
          (authParams.token as string) ??
          (authParams.bearerToken as string) ??
          ""

        if (!clientToken) {
          log("warn", "acp.auth_missing", { reason: "No auth token provided" })
          throw new Error("Authentication required. Provide apiKey, token, or bearerToken.")
        }

        if (!validateApiKey(clientToken, app.authConfig)) {
          log("warn", "acp.auth_invalid")
          throw new Error("Invalid API key.")
        }
      }
      log("info", "acp.authenticate")
      return {}
    },

    // ── cancel ────────────────────────────────────────────────────────
    async cancel(params) {
      log("info", "acp.cancel", { sessionId: params.sessionId })
      const acpSession = sessions.get(params.sessionId)
      if (acpSession) {
        try {
          acpSession.abortController.abort()
        } catch {
          /* ignore */
        }
        // Create a fresh abort controller for future prompts.
        acpSession.abortController = new AbortController()
      }
    },
  }
}
