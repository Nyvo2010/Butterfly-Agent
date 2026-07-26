/**
 * Permission route group — manage human-in-the-loop permission requests.
 *
 * When the agent needs approval for a destructive operation (write/bash),
 * a permission request is published on the bus. The client displays it and
 * the user responds via this route. Inspired by OpenCode's permission route group.
 *
 * Permission requests are tracked in-memory (not persisted) since they are
 * transient runtime state.
 */

import { randomUUID } from "node:crypto"
import type { ServerApp } from "../app"
import type { Router } from "../router"
import { badRequest, notFound, ok } from "../router"

interface PendingPermission {
  requestId: string
  sessionId: string
  tool: string
  question: string
  options?: string[]
  /** Resolver called when the user responds. */
  resolve: (answer: string) => void
  createdAt: string
}

const pending = new Map<string, PendingPermission>()

export function registerPermissionRoutes(router: Router, _app: ServerApp): void {
  // ── List pending permission requests ───────────────────────────────────
  router.get("/api/permission", (ctx) => {
    const sessionId = ctx.query.sessionId
    const all = Array.from(pending.values())
    const filtered = sessionId ? all.filter((p) => p.sessionId === sessionId) : all
    ok(ctx.res, {
      pending: filtered.map((p) => ({
        requestId: p.requestId,
        sessionId: p.sessionId,
        tool: p.tool,
        question: p.question,
        options: p.options,
        createdAt: p.createdAt,
      })),
    })
  })

  // ── Respond to a permission request ────────────────────────────────────
  router.post("/api/permission/:requestId/reply", (ctx) => {
    const req = pending.get(ctx.params.requestId)
    if (!req) {
      notFound(ctx.res, `Permission request not found: ${ctx.params.requestId}`)
      return
    }
    const answer = String(ctx.body.answer ?? "")
    if (!answer) {
      badRequest(ctx.res, "answer is required")
      return
    }
    req.resolve(answer)
    pending.delete(ctx.params.requestId)
    ok(ctx.res, { resolved: true, answer })
  })
}

/** Default timeout for permission requests (5 minutes). */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Create a permission request and wait for the user's response.
 * Used by the server's onAskUser callback — publishes a permission.requested
 * event on the bus, then blocks until the user responds via the HTTP route.
 *
 * This bridges the synchronous agent loop (which awaits onAskUser) with the
 * asynchronous HTTP client (which responds later).
 *
 * Times out after PERMISSION_TIMEOUT_MS (default 5 min) to prevent the agent
 * loop from hanging forever if the user never responds. Returns null on
 * timeout, which the agent loop treats as a denied permission.
 */
export function requestPermission(
  app: ServerApp,
  sessionId: string,
  tool: string,
  question: string,
  options?: string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const requestId = `perm-${randomUUID()}`
    let timedOut = false
    const timeout = setTimeout(() => {
      if (timedOut) return
      timedOut = true
      pending.delete(requestId)
      app.bus.emit({
        kind: "permission.resolved",
        sessionId,
        data: { requestId, allowed: false },
      })
      resolve(null)
    }, PERMISSION_TIMEOUT_MS)

    const entry: PendingPermission = {
      requestId,
      sessionId,
      tool,
      question,
      options,
      resolve: (answer: string) => {
        if (timedOut) return
        clearTimeout(timeout)
        app.bus.emit({
          kind: "permission.resolved",
          sessionId,
          data: { requestId, allowed: answer === "yes" },
        })
        resolve(answer)
      },
      createdAt: new Date().toISOString(),
    }
    pending.set(requestId, entry)
    app.bus.emit({
      kind: "permission.requested",
      sessionId,
      data: { requestId, tool, question, options },
    })
  })
}

/** Check if a session has any pending permission requests. */
export function hasPendingPermissions(sessionId: string): boolean {
  for (const p of pending.values()) {
    if (p.sessionId === sessionId) return true
  }
  return false
}
