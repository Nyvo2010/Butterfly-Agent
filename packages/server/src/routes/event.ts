/**
 * Event route group — global SSE event stream with Last-Event-ID replay.
 */

import type { ServerResponse } from "node:http"
import type { ServerApp } from "../app"
import type { ButterflyEvent } from "../bus"
import type { Router } from "../router"

const KEEPALIVE_MS = 15_000
const RETRY_MS = 3_000

function writeSseEvent(res: ServerResponse, event: ButterflyEvent): boolean {
  const lines: string[] = [`id: ${event.id}`, `data: ${JSON.stringify(event)}`]
  return res.write(`${lines.join("\n")}\n\n`)
}

function writeComment(res: ServerResponse): boolean {
  return res.write(`: keepalive\n\n`)
}

function sseHead(res: ServerResponse, corsHeaders: Record<string, string>): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders,
  })
  res.write(`retry: ${RETRY_MS}\n\n`)
}

function parseLastEventId(req: import("node:http").IncomingMessage): string | undefined {
  const raw = req.headers["last-event-id"]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value?.trim() || undefined
}

function streamEvents(
  res: ServerResponse,
  req: import("node:http").IncomingMessage,
  corsHeaders: Record<string, string>,
  replay: (afterId: string | undefined) => ButterflyEvent[],
  subscribe: (handler: (event: ButterflyEvent) => void) => () => void,
  connectPayload: ButterflyEvent,
): void {
  sseHead(res, corsHeaders)

  const lastEventId = parseLastEventId(req)
  for (const event of replay(lastEventId)) {
    if (!writeSseEvent(res, event)) {
      res.destroy()
      return
    }
  }

  if (!writeSseEvent(res, connectPayload)) {
    res.destroy()
    return
  }

  const unsubscribe = subscribe((event) => {
    try {
      if (!writeSseEvent(res, event)) {
        unsubscribe()
        clearInterval(keepAlive)
        res.destroy()
      }
    } catch {
      unsubscribe()
      clearInterval(keepAlive)
    }
  })

  const keepAlive = setInterval(() => {
    try {
      if (!writeComment(res)) {
        clearInterval(keepAlive)
        unsubscribe()
        res.destroy()
      }
    } catch {
      clearInterval(keepAlive)
      unsubscribe()
    }
  }, KEEPALIVE_MS)

  req.on("close", () => {
    clearInterval(keepAlive)
    unsubscribe()
  })
}

export function registerEventRoutes(router: Router, app: ServerApp): void {
  router.get("/api/event", (ctx) => {
    streamEvents(
      ctx.res as ServerResponse,
      ctx.req,
      ctx.corsHeaders,
      (afterId) => app.bus.replay(afterId),
      (handler) => app.bus.subscribe(handler),
      {
        kind: "stream.connected",
        type: "stream",
        id: "evt-bootstrap",
        timestamp: new Date().toISOString(),
        data: {},
      } as ButterflyEvent,
    )
  })

  router.get("/api/sessions/:id/stream", (ctx) => {
    const sessionId = ctx.params.id
    streamEvents(
      ctx.res as ServerResponse,
      ctx.req,
      ctx.corsHeaders,
      (afterId) => app.bus.replay(afterId, sessionId),
      (handler) => app.bus.subscribeToSession(sessionId, handler),
      {
        kind: "stream.connected",
        type: "stream",
        sessionId,
        id: "evt-bootstrap",
        timestamp: new Date().toISOString(),
        data: {},
      } as ButterflyEvent,
    )
  })
}
