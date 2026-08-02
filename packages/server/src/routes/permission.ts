/**
 * Permission route group — manage human-in-the-loop permission requests.
 */

import { randomUUID } from "node:crypto"
import type { PermissionCategory } from "@butterfly/agent"
import type { ServerApp } from "../app"
import type { PendingPermissionEntry } from "../permission-store"
import type { Router } from "../router"
import { badRequest, notFound, ok } from "../router"

/** Default timeout for permission requests (5 minutes). */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

export function registerPermissionRoutes(router: Router, app: ServerApp): void {
  router.get("/api/permission", (ctx) => {
    ok(ctx.res, { pending: app.permissionStore.list(ctx.query.sessionId) }, ctx.corsHeaders)
  })

  router.post("/api/permission/:requestId/reply", (ctx) => {
    const req = app.permissionStore.get(ctx.params.requestId)
    if (!req) {
      notFound(ctx.res, `Permission request not found: ${ctx.params.requestId}`, ctx.corsHeaders)
      return
    }
    const answer = String(ctx.body.answer ?? "")
    if (!answer) {
      badRequest(ctx.res, "answer is required", ctx.corsHeaders)
      return
    }
    req.resolve(answer)
    app.permissionStore.delete(ctx.params.requestId)
    ok(ctx.res, { resolved: true, answer }, ctx.corsHeaders)
  })
}

export function requestPermission(
  app: ServerApp,
  sessionId: string,
  tool: string,
  question: string,
  options?: string[],
  category: PermissionCategory = "ask_user",
  /** Override the default timeout (used by tests). */
  timeoutMs: number = PERMISSION_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    const requestId = `perm-${randomUUID()}`
    let timedOut = false

    const timeout = setTimeout(() => {
      if (timedOut) return
      timedOut = true
      app.permissionStore.delete(requestId)
      app.bus.emit({
        kind: "permission.resolved",
        sessionId,
        data: { requestId, allowed: false },
      })
      resolve(null)
    }, timeoutMs)

    const entry: PendingPermissionEntry = {
      requestId,
      sessionId,
      tool,
      category,
      question,
      options,
      createdAt: new Date().toISOString(),
      timeout,
      resolve: (answer: string | null) => {
        if (timedOut) return
        timedOut = true
        clearTimeout(timeout)
        app.bus.emit({
          kind: "permission.resolved",
          sessionId,
          data: { requestId, allowed: answer === "yes" },
        })
        resolve(answer)
      },
    }

    app.permissionStore.set(entry)
    app.bus.emit({
      kind: "permission.requested",
      sessionId,
      data: { requestId, tool, question, options, category },
    })
  })
}

export function hasPendingPermissions(app: ServerApp, sessionId: string): boolean {
  return app.permissionStore.hasPendingForSession(sessionId)
}
