/**
 * Session route group — session CRUD, agent prompt, fork, abort, summarize.
 *
 * Inspired by OpenCode's session route group but with Butterfly-specific
 * extensions (tier, SCE/COE config). All session mutations go through
 * SessionManager which emits events on the bus.
 */

import type { ServerApp } from "../app"
import type { Router } from "../router"
import { badRequest, created, json, notFound, ok } from "../router"
import { requestPermission } from "./permission"

export function registerSessionRoutes(router: Router, app: ServerApp): void {
  // ── List sessions ──────────────────────────────────────────────────────
  router.get("/api/sessions", async (ctx) => {
    const includeArchived = ctx.query.archived === "true"
    const entries = await app.sessionManager.list(includeArchived)
    // Enrich with title + usage summary for the client.
    const sessions = []
    for (const entry of entries) {
      const session = await app.sessionManager.load(entry.id)
      if (session) {
        sessions.push({
          id: session.id,
          mode: session.mode,
          tier: session.tier,
          title: session.title ?? "Untitled",
          selectedModel: session.selectedModel ?? "auto",
          updatedAt: session.updatedAt,
          startedAt: session.startedAt,
          usage: session.usage,
          archived: session.archived ?? false,
          parentSessionId: session.parentSessionId,
        })
      }
    }
    ok(ctx.res, { sessions })
  })

  // ── Create session ─────────────────────────────────────────────────────
  router.post("/api/sessions", async (ctx) => {
    const mode = (ctx.body.mode as string) || "build"
    if (mode !== "plan" && mode !== "build") {
      badRequest(ctx.res, `Invalid mode: ${mode}. Use: plan, build`)
      return
    }
    const tier = (ctx.body.tier as string) || "standard"
    const selectedModel = ctx.body.selectedModel as string | undefined
    const session = await app.sessionManager.create({
      mode: mode as "plan" | "build",
      tier: tier as "trivial" | "standard" | "complex" | "escalate",
      title: ctx.body.title as string | undefined,
      selectedModel,
    })
    created(ctx.res, { session })
  })

  // ── Get session ────────────────────────────────────────────────────────
  router.get("/api/sessions/:id", async (ctx) => {
    const session = await app.sessionManager.load(ctx.params.id)
    if (!session) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`)
      return
    }
    ok(ctx.res, { session })
  })

  // ── Delete session ─────────────────────────────────────────────────────
  router.delete("/api/sessions/:id", async (ctx) => {
    // Abort any active run first.
    app.runState.abort(ctx.params.id)
    await app.sessionManager.delete(ctx.params.id)
    ok(ctx.res, { deleted: true })
  })

  // ── Update session (mode, tier, title, archived, selectedModel) ────────
  router.patch("/api/sessions/:id", async (ctx) => {
    const fields: {
      mode?: "plan" | "build"
      tier?: "trivial" | "standard" | "complex" | "escalate"
      title?: string
      archived?: boolean
      selectedModel?: string
    } = {}
    if (ctx.body.mode === "plan" || ctx.body.mode === "build") fields.mode = ctx.body.mode
    if (
      ctx.body.tier === "trivial" ||
      ctx.body.tier === "standard" ||
      ctx.body.tier === "complex" ||
      ctx.body.tier === "escalate"
    ) {
      fields.tier = ctx.body.tier
    }
    if (typeof ctx.body.title === "string") fields.title = ctx.body.title
    if (typeof ctx.body.archived === "boolean") fields.archived = ctx.body.archived
    if (typeof ctx.body.selectedModel === "string") fields.selectedModel = ctx.body.selectedModel

    const session = await app.sessionManager.update(ctx.params.id, fields)
    if (!session) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`)
      return
    }
    ok(ctx.res, { session })
  })

  // ── Fork session ───────────────────────────────────────────────────────
  router.post("/api/sessions/:id/fork", async (ctx) => {
    const forked = await app.sessionManager.fork(ctx.params.id)
    if (!forked) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`)
      return
    }
    created(ctx.res, { session: forked })
  })

  // ── Abort session run ──────────────────────────────────────────────────
  router.post("/api/sessions/:id/abort", async (ctx) => {
    const aborted = app.runState.abort(ctx.params.id)
    ok(ctx.res, { aborted })
  })

  // ── Summarize session ──────────────────────────────────────────────────
  router.post("/api/sessions/:id/summarize", async (ctx) => {
    const session = await app.sessionManager.summarize(ctx.params.id)
    if (!session) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`)
      return
    }
    ok(ctx.res, { session })
  })

  // ── Get session messages ───────────────────────────────────────────────
  router.get("/api/sessions/:id/messages", async (ctx) => {
    const session = await app.sessionManager.load(ctx.params.id)
    if (!session) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`)
      return
    }
    ok(ctx.res, { messages: session.messages })
  })

  // ── Get session tool calls ─────────────────────────────────────────────
  router.get("/api/sessions/:id/tool-calls", async (ctx) => {
    const session = await app.sessionManager.load(ctx.params.id)
    if (!session) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`)
      return
    }
    ok(ctx.res, { toolCalls: session.toolCalls })
  })

  // ── Get session file changes ───────────────────────────────────────────
  router.get("/api/sessions/:id/file-changes", async (ctx) => {
    const session = await app.sessionManager.load(ctx.params.id)
    if (!session) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`)
      return
    }
    ok(ctx.res, { fileChanges: session.fileChanges })
  })

  // ── Get session run status ─────────────────────────────────────────────
  router.get("/api/sessions/:id/status", async (ctx) => {
    ok(ctx.res, {
      sessionId: ctx.params.id,
      status: app.runState.status(ctx.params.id),
    })
  })

  // ── Run agent (POST /api/sessions/:id/prompt) ──────────────────────────
  router.post("/api/sessions/:id/prompt", async (ctx) => {
    const sessionId = ctx.params.id
    const query = String(ctx.body.prompt ?? ctx.body.query ?? "")
    if (!query.trim()) {
      badRequest(ctx.res, "prompt is required")
      return
    }

    let session = await app.sessionManager.load(sessionId)
    if (!session) {
      session = await app.sessionManager.create({ id: sessionId })
    }

    const { abort } = app.runState.start(sessionId)

    let agent: Awaited<ReturnType<typeof app.createAgent>> | undefined
    try {
      // Wire the human-in-the-loop permission system: the ask_user tool
      // publishes a permission.requested event and blocks until the user
      // responds via POST /api/permission/:id/reply.
      agent = await app.createAgent({
        sessionId,
        onAskUser: (question, options) =>
          requestPermission(app, sessionId, "ask_user", question, options),
      })

      const sceOpts = app.butterflyConfig.butterfly?.sce
      const coeOpts = app.butterflyConfig.butterfly?.coe

      const result = await agent.loop.run({
        session,
        query,
        cwd: app.cwd,
        maxSteps: ctx.body.maxSteps
          ? Number(ctx.body.maxSteps)
          : (app.butterflyConfig.butterfly?.maxSteps ?? 20),
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

      await app.sessionManager.save(result.session)

      // Distinguish aborted runs from normal completion: if the abort signal
      // fired, the loop returned early — report it as aborted, not completed.
      // Pass `abort` so runState only acts if this is still the active entry —
      // a newer prompt's start() already cleaned up the old entry and emitted
      // run.aborted, so we don't duplicate the event.
      if (abort.signal.aborted) {
        app.runState.abort(sessionId, abort)
        ok(ctx.res, {
          sessionId: result.session.id,
          iterations: result.iterations,
          stopReason: "aborted",
          model: result.lastResolution.model,
          tier: result.lastResolution.tier,
          usage: result.session.usage,
          fileChanges: result.session.fileChanges.map((f) => ({ path: f.path, kind: f.kind })),
          toolCalls: result.session.toolCalls.map((t) => ({ name: t.name, error: t.error })),
        })
        return
      }

      app.runState.complete(
        sessionId,
        {
          iterations: result.iterations,
          stopReason: result.stopReason,
          model: result.lastResolution.model,
          tier: result.lastResolution.tier,
        },
        abort,
      )

      ok(ctx.res, {
        sessionId: result.session.id,
        iterations: result.iterations,
        stopReason: result.stopReason,
        model: result.lastResolution.model,
        tier: result.lastResolution.tier,
        usage: result.session.usage,
        fileChanges: result.session.fileChanges.map((f) => ({ path: f.path, kind: f.kind })),
        toolCalls: result.session.toolCalls.map((t) => ({ name: t.name, error: t.error })),
      })
    } catch (err) {
      app.runState.error(sessionId, (err as Error).message, abort)
      json(ctx.res, 500, { error: (err as Error).message })
    } finally {
      if (agent) await agent.dispose()
    }
  })
}
