/**
 * Event route group — global SSE event stream.
 *
 * This is the cornerstone of the client/server split: the client opens a single
 * SSE connection to /api/event and receives ALL Butterfly events (session, run,
 * tool, stream, file, permission, mcp). No polling, no per-endpoint subscriptions.
 *
 * Inspired by OpenCode's GET /event route. The bus is the single source of truth;
 * this route just bridges in-memory events to the network.
 */

import type { ServerResponse } from "node:http"
import type { ServerApp } from "../app"
import type { ButterflyEvent } from "../bus"
import type { Router } from "../router"
import { CORS_HEADERS } from "../router"

export function registerEventRoutes(router: Router, app: ServerApp): void {
  // ── Global event stream (SSE) ──────────────────────────────────────────
  router.get("/api/event", (ctx) => {
    const res = ctx.res as ServerResponse

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    })

    // Send an initial connected event so the client knows the stream is live.
    res.write(`data: ${JSON.stringify({ kind: "stream.connected", type: "stream", data: {} })}\n\n`)

    // Subscribe to all bus events and forward them as SSE data lines.
    const unsubscribe = app.bus.subscribe((event: ButterflyEvent) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      } catch {
        // Client disconnected — unsubscribe will handle cleanup.
        unsubscribe()
      }
    })

    // Keepalive every 15s to prevent proxy timeouts.
    const keepAlive = setInterval(() => {
      try {
        res.write(": keepalive\n\n")
      } catch {
        clearInterval(keepAlive)
        unsubscribe()
      }
    }, 15_000)

    // Clean up on client disconnect.
    ctx.req.on("close", () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  })

  // ── Session-specific event stream (SSE) ────────────────────────────────
  router.get("/api/sessions/:id/stream", (ctx) => {
    const res = ctx.res as ServerResponse
    const sessionId = ctx.params.id

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    })

    res.write(
      `data: ${JSON.stringify({ kind: "stream.connected", type: "stream", sessionId, data: {} })}\n\n`,
    )

    const unsubscribe = app.bus.subscribeToSession(sessionId, (event: ButterflyEvent) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      } catch {
        unsubscribe()
      }
    })

    const keepAlive = setInterval(() => {
      try {
        res.write(": keepalive\n\n")
      } catch {
        clearInterval(keepAlive)
        unsubscribe()
      }
    }, 15_000)

    ctx.req.on("close", () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  })
}
