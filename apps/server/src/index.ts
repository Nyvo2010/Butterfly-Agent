/**
 * Butterfly Agent — HTTP Server
 *
 * OpenCode-compatible server/client architecture:
 * - REST API for session management and agent execution
 * - SSE streaming for real-time agent execution (text_delta, tool_start, tool_result)
 * - Shared LLM client, tokenizer, store across requests; agent loop per-request for streaming isolation
 * - /providers endpoint for client discovery
 *
 * Endpoints:
 *   GET  /health                          — health check
 *   GET  /providers                       — list supported LLM providers
 *   POST /api/sessions                    — create new session
 *   GET  /api/sessions                    — list all sessions
 *   GET  /api/sessions/:id                — get session detail
 *   DELETE /api/sessions/:id              — delete a session
 *   POST /api/sessions/:id/prompt         — run agent with prompt
 *   GET  /api/sessions/:id/stream         — SSE stream for real-time agent events
 */

import { createServer } from "node:http"
import { createAgent } from "@butterfly/agent"
import { GPTTokenizer } from "@butterfly/context"
import {
  findWorkspaceRoot,
  loadButterflyConfig,
  loadConfig,
  loadDotEnv,
  log,
  setLogLevel,
} from "@butterfly/core"
import { createClient } from "@butterfly/llm"
import { createSession, FileSystemSessionStore } from "@butterfly/session"

// ─── Types ────────────────────────────────────────────────────────────────────

interface SSEEvent {
  type: "text_delta" | "tool_start" | "tool_result" | "iteration" | "done" | "error" | "connected"
  data: unknown
  timestamp: string
}

interface ActiveRun {
  sessionId: string
  abort: AbortController
  sseClients: Set<(event: SSEEvent) => void>
  startedAt: string
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

function respond(res: import("node:http").ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS })
  res.end(JSON.stringify(data))
}

const MAX_BODY_BYTES = 1_000_000

async function parseBody(
  req: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ""
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body too large: ${size} bytes exceeds ${MAX_BODY_BYTES} limit`))
        req.destroy()
        return
      }
      data += chunk
    })
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {})
      } catch (err) {
        reject(new Error(`Invalid JSON: ${(err as Error).message}`))
      }
    })
    req.on("error", reject)
  })
}

// ─── Supported LLM Providers ─────────────────────────────────────────────────

function getProvidersList(bfConfig: {
  providers?: Record<string, { provider: string; disabled?: boolean }>
}) {
  const configured = bfConfig.providers
  if (configured && Object.keys(configured).length > 0) {
    return Object.entries(configured)
      .filter(([, c]) => !c.disabled)
      .map(([name, c]) => ({
        id: name,
        provider: c.provider,
        name: `${name} (${c.provider})`,
        prefix: `${name}/`,
      }))
  }
  // Fallback: show env-var-based defaults
  return [
    { id: "anthropic", provider: "anthropic", name: "Anthropic (env)", prefix: "anthropic/" },
    { id: "gemini", provider: "gemini", name: "Google Gemini (env)", prefix: "gemini/" },
    { id: "openai", provider: "openai", name: "OpenAI & Compatible (env)", prefix: "openai/" },
  ]
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load .env from multiple possible locations (pnpm --filter may change cwd)
  const root = findWorkspaceRoot(process.cwd())
  const envPaths = [`${root}/.env`, `${process.cwd()}/.env`]
  let loaded = false
  for (const p of envPaths) {
    const count = loadDotEnv(p)
    if (count > 0) {
      loaded = true
      break
    }
  }
  if (!loaded) {
    // Try loading from the project root relative to this file
    const tryPath = `${findWorkspaceRoot(import.meta.dirname ?? process.cwd())}/.env`
    loadDotEnv(tryPath)
  }

  const CWD = process.env.BUTTERFLY_CWD || process.cwd()
  const cfg = loadConfig()
  setLogLevel(cfg.agent.logLevel)

  const PORT = Number(process.env.PORT) || 3_000

  const store = new FileSystemSessionStore()
  const activeRuns = new Map<string, ActiveRun>()

  // ── Shared heavy deps (reused across requests) ──────────────────────────
  const tokenizer = new GPTTokenizer()
  tokenizer.warmup()

  const bfConfig = loadButterflyConfig(CWD)
  const model = bfConfig.model ?? ""
  const llm = createClient(model, cfg.llm, bfConfig.providers)

  log("info", "server.start", {
    port: PORT,
    cwd: CWD,
    model: model || "default",
    baseUrl: cfg.llm.baseUrl || "default",
  })

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS).end()
      return
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
    const { pathname: path } = url
    const method = req.method || "GET"

    try {
      // ── Health ──────────────────────────────────────────────────────────
      if (path === "/health" && method === "GET") {
        respond(res, 200, {
          status: "ok",
          uptime: process.uptime(),
          activeRuns: activeRuns.size,
          model: model || "default",
        })
        return
      }

      // ── Providers ───────────────────────────────────────────────────────
      if (path === "/providers" && method === "GET") {
        respond(res, 200, { providers: getProvidersList(bfConfig), current: model || "default" })
        return
      }

      // ── List Sessions ───────────────────────────────────────────────────
      if (path === "/api/sessions" && method === "GET") {
        const sessions = await store.list()
        respond(res, 200, { sessions })
        return
      }

      // ── Create Session ──────────────────────────────────────────────────
      if (path === "/api/sessions" && method === "POST") {
        const body = await parseBody(req)
        const mode = (body.mode as string) || "build"
        const validModes = ["plan", "build"]
        if (!validModes.includes(mode)) {
          respond(res, 400, { error: `Invalid mode: ${mode}. Use: ${validModes.join(", ")}` })
          return
        }
        const session = createSession(`srv-${Date.now()}`, mode as "plan" | "build")
        await store.save(session)
        log("info", "server.session_created", { sessionId: session.id, mode })
        respond(res, 201, { session })
        return
      }

      // ── Get / Delete Session ────────────────────────────────────────────
      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/)
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1])

        if (method === "GET") {
          const session = await store.load(sessionId)
          if (!session) return respond(res, 404, { error: `Session not found: ${sessionId}` })
          respond(res, 200, { session })
          return
        }

        if (method === "DELETE") {
          const active = activeRuns.get(sessionId)
          if (active) {
            active.abort.abort()
            activeRuns.delete(sessionId)
          }
          const { unlink } = await import("node:fs/promises")
          const { join } = await import("node:path")
          try {
            await unlink(join(CWD, ".butterfly", "sessions", `${sessionId}.json`))
          } catch {
            // File may not exist — that's fine
          }
          respond(res, 200, { deleted: true })
          return
        }
      }

      // ── Run Agent (POST /api/sessions/:id/prompt) ───────────────────────
      const promptMatch = path.match(/^\/api\/sessions\/(.+)\/prompt$/)
      if (promptMatch && method === "POST") {
        const sessionId = decodeURIComponent(promptMatch[1])
        const body = await parseBody(req)
        const query = String(body.prompt ?? "")
        if (!query.trim()) return respond(res, 400, { error: "prompt is required" })

        let session = await store.load(sessionId)
        if (!session) {
          session = createSession(sessionId, "build")
        }

        // Cancel existing run for this session
        const existingRun = activeRuns.get(sessionId)
        if (existingRun) {
          existingRun.abort.abort()
          activeRuns.delete(sessionId)
        }

        const abort = new AbortController()
        const sseClients = new Set<(event: SSEEvent) => void>()
        activeRuns.set(sessionId, {
          sessionId,
          abort,
          sseClients,
          startedAt: new Date().toISOString(),
        })

        const broadcastSSE = (event: SSEEvent) => {
          for (const client of sseClients) client(event)
        }

        log("info", "server.prompt_start", { sessionId, query: query.slice(0, 200) })

        let agent: Awaited<ReturnType<typeof createAgent>> | undefined
        try {
          // Create agent per-request with streaming callbacks wired to SSE.
          // Heavy deps (llm, tokenizer, store, config) are shared across requests.
          agent = await createAgent({
            cwd: CWD,
            llm,
            tokenizer,
            store,
            config: bfConfig,
            onStreamEvent: (event) => {
              if (event.kind === "text_delta" && event.text) {
                broadcastSSE({
                  type: "text_delta",
                  data: { text: event.text },
                  timestamp: new Date().toISOString(),
                })
              } else if (event.kind === "tool_call_delta") {
                broadcastSSE({
                  type: "tool_start",
                  data: { name: event.name, id: event.id, input: event.input },
                  timestamp: new Date().toISOString(),
                })
              }
            },
            onIteration: (s, iteration) => {
              broadcastSSE({
                type: "iteration",
                data: {
                  iteration,
                  messageCount: s.messages.length,
                  toolCalls: s.toolCalls.length,
                  fileChanges: s.fileChanges.length,
                },
                timestamp: new Date().toISOString(),
              })
            },
          })

          const sceOpts = bfConfig.butterfly?.sce
          const coeOpts = bfConfig.butterfly?.coe

          const result = await agent.loop.run({
            session,
            query,
            cwd: CWD,
            maxSteps: body.maxSteps ? Number(body.maxSteps) : 20,
            maxContextTokens: coeOpts?.maxContextTokens ?? 8000,
            toolMessageMaxTokens: coeOpts?.toolMessageMaxTokens,
            signal: abort.signal,
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

          await store.save(result.session)

          const finalMsgs = result.session.messages
            .filter((m: { role: string }) => m.role === "assistant")
            .slice(-3)

          // Emit tool_result events for all completed tool calls
          for (const tc of result.session.toolCalls) {
            broadcastSSE({
              type: "tool_result",
              data: {
                name: tc.name,
                status: tc.error ? "error" : "done",
                error: tc.error,
                input: tc.input,
              },
              timestamp: new Date().toISOString(),
            })
          }

          broadcastSSE({
            type: "done",
            data: {
              sessionId: result.session.id,
              iterations: result.iterations,
              stopReason: result.stopReason,
              model: result.lastResolution.model,
              tier: result.lastResolution.tier,
              messages: finalMsgs.map((m: { role: string; content: string }) => ({
                role: m.role,
                content: m.content.slice(0, 500),
              })),
              fileChanges: result.session.fileChanges.map((f: { path: string; kind: string }) => ({
                path: f.path,
                kind: f.kind,
              })),
              toolCalls: result.session.toolCalls.map((t: { name: string; error?: string }) => ({
                name: t.name,
                error: t.error,
              })),
            },
            timestamp: new Date().toISOString(),
          })

          respond(res, 200, {
            sessionId: result.session.id,
            iterations: result.iterations,
            stopReason: result.stopReason,
            model: result.lastResolution.model,
            fileChanges: result.session.fileChanges.map((f) => ({ path: f.path, kind: f.kind })),
          })
        } catch (err) {
          log("error", "server.prompt_error", { sessionId, error: (err as Error).message })
          broadcastSSE({
            type: "error",
            data: { message: (err as Error).message },
            timestamp: new Date().toISOString(),
          })
          if (!res.headersSent) {
            respond(res, 500, { error: (err as Error).message })
          }
        } finally {
          if (agent) await agent.dispose()
          activeRuns.delete(sessionId)
        }
        return
      }

      // ── SSE Stream (GET /api/sessions/:id/stream) ───────────────────────
      const streamMatch = path.match(/^\/api\/sessions\/(.+)\/stream$/)
      if (streamMatch && method === "GET") {
        const sessionId = decodeURIComponent(streamMatch[1])

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...CORS,
        })

        const onSSE = (event: SSEEvent) => {
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`)
          } catch {
            // Client disconnected
          }
        }

        onSSE({ type: "connected", data: { sessionId }, timestamp: new Date().toISOString() })

        const active = activeRuns.get(sessionId)
        if (active) {
          active.sseClients.add(onSSE)
        }

        const keepAlive = setInterval(() => {
          try {
            res.write(": keepalive\n\n")
          } catch {
            clearInterval(keepAlive)
          }
        }, 15_000)

        req.on("close", () => {
          clearInterval(keepAlive)
          const run = activeRuns.get(sessionId)
          if (run) run.sseClients.delete(onSSE)
        })
        return
      }

      // ── 404 ─────────────────────────────────────────────────────────────
      if (!res.headersSent) {
        respond(res, 404, { error: `Not found: ${method} ${path}` })
      }
    } catch (err) {
      log("error", "server.request_error", { path, error: (err as Error).message })
      if (!res.headersSent) {
        respond(res, 500, { error: (err as Error).message })
      }
    }
  })

  server.listen(PORT, () => {
    process.stderr.write(`\n🦋 Butterfly Server running at http://localhost:${PORT}\n`)
    process.stderr.write(`   Health:    http://localhost:${PORT}/health\n`)
    process.stderr.write(`   Providers: http://localhost:${PORT}/providers\n`)
    process.stderr.write(`   API:       http://localhost:${PORT}/api/sessions\n`)
    process.stderr.write(`   Stream:    http://localhost:${PORT}/api/sessions/:id/stream\n\n`)
  })

  const shutdown = async () => {
    process.stderr.write("\nShutting down...\n")
    for (const [, run] of activeRuns) run.abort.abort()
    activeRuns.clear()
    server.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  process.stderr.write(`Server fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
