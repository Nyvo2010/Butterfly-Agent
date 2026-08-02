/**
 * Session route group — session CRUD, agent prompt, fork, abort, summarize.
 *
 * Inspired by OpenCode's session route group but with Butterfly-specific
 * extensions (tier, SCE/COE config). All session mutations go through
 * SessionManager which emits events on the bus.
 */

import { writeFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { getSnapshotService } from "@butterfly/agent"
import { isPathInWorkspace } from "@butterfly/tools"
import { runSessionPrompt } from "../agent-run"
import type { ServerApp } from "../app"

/**
 * Extract external file references from a prompt string.
 * Matches patterns like @path/to/file.ts (word characters, dots, slashes, hyphens).
 * Returns unique, deduplicated paths relative to the workspace.
 */
export function extractRefs(prompt: string): string[] {
  const refs: string[] = []
  const seen = new Set<string>()
  // Match @ followed by a file path (word chars, dots, slashes, hyphens)
  const re = /@([\w./-]+(?:\.\w+))/g
  let match: RegExpExecArray | null
  while (true) {
    match = re.exec(prompt)
    if (match === null) break
    const path = match[1]
    if (!seen.has(path)) {
      seen.add(path)
      refs.push(path)
    }
  }
  return refs
}

import { decodeCursor, encodeCursor, isAfterCursor, isAfterCursorDesc, parseLimit } from "../cursor"
import { unifiedDiffForFile } from "../diff"
import type { Router } from "../router"
import { accepted, badRequest, created, json, notFound, ok } from "../router"

export function registerSessionRoutes(router: Router, app: ServerApp): void {
  // ── List available slash commands ─────────────────────────────────────
  // Registered BEFORE /api/sessions/:id so the static "commands" segment wins.
  router.get("/api/sessions/commands", async (ctx) => {
    const commands = app.butterflyConfig.commands ?? {}
    ok(ctx.res, { commands }, ctx.corsHeaders)
  })

  // ── Search sessions (by title / summary / message content) ────────────
  // Registered BEFORE /api/sessions/:id so the static "search" segment wins.
  router.get("/api/sessions/search", async (ctx) => {
    const q = String(ctx.query.q ?? "")
    if (!q.trim()) {
      badRequest(ctx.res, "q is required", ctx.corsHeaders)
      return
    }
    const limit = parseLimit(ctx.query.limit, 20)
    const results = await app.sessionManager.search(q, limit)
    ok(ctx.res, { query: q, results }, ctx.corsHeaders)
  })

  // ── Import session (from export JSON) ─────────────────────────────────
  router.post("/api/sessions/import", async (ctx) => {
    const session = await app.sessionManager.import(ctx.body.session ?? ctx.body)
    if (!session) {
      badRequest(ctx.res, "Invalid session data: expected exported session JSON", ctx.corsHeaders)
      return
    }
    created(ctx.res, { session }, ctx.corsHeaders)
  })

  // ── List sessions (cursor-paginated) ──────────────────────────────────
  router.get("/api/sessions", async (ctx) => {
    const includeArchived = ctx.query.archived === "true"
    const limit = parseLimit(ctx.query.limit)
    const cursor = decodeCursor(ctx.query.cursor)
    const entries = await app.sessionManager.list(includeArchived)
    // Entries are already sorted by updatedAt desc (see FileSystemSessionStore.list).
    const page = []
    for (const entry of entries) {
      // Sessions are sorted newest-first (updatedAt desc) — use desc cursor.
      if (cursor && !isAfterCursorDesc({ id: entry.id, time: entry.updatedAt }, cursor)) continue
      const session = await app.sessionManager.load(entry.id)
      if (!session) continue
      page.push({
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
      if (page.length >= limit) break
    }
    const last = page.at(-1)
    ok(ctx.res, {
      sessions: page,
      ...(last
        ? { nextCursor: encodeCursor({ id: last.id, time: last.updatedAt }) }
        : { nextCursor: null }),
    })
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

  // ── Get session messages (cursor-paginated) ────────────────────────────
  router.get("/api/sessions/:id/messages", async (ctx) => {
    const session = await app.sessionManager.load(ctx.params.id)
    if (!session) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`)
      return
    }
    const limit = parseLimit(ctx.query.limit)
    const cursor = decodeCursor(ctx.query.cursor)
    const messages = session.messages
    const page = []
    for (const m of messages) {
      if (cursor && !isAfterCursor({ id: m.id, time: m.timestamp }, cursor)) continue
      page.push(m)
      if (page.length >= limit) break
    }
    const last = page.at(-1)
    ok(ctx.res, {
      messages: page,
      ...(last
        ? { nextCursor: encodeCursor({ id: last.id, time: last.timestamp }) }
        : { nextCursor: null }),
    })
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

  // ── Get session run status (honest: running / idle / interrupted) ─────
  router.get("/api/sessions/:id/status", async (ctx) => {
    const session = await app.sessionManager.load(ctx.params.id)
    if (!session) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`, ctx.corsHeaders)
      return
    }
    const live = app.runState.status(ctx.params.id)
    if (live === "running") {
      ok(ctx.res, { sessionId: ctx.params.id, status: "running" }, ctx.corsHeaders)
      return
    }
    // No live run, but a persisted marker exists → interrupted by restart.
    if (session.activeRun) {
      ok(
        ctx.res,
        {
          sessionId: ctx.params.id,
          status: "interrupted",
          activeRun: session.activeRun,
        },
        ctx.corsHeaders,
      )
      return
    }
    ok(ctx.res, { sessionId: ctx.params.id, status: "idle" }, ctx.corsHeaders)
  })

  // ── Export session (portable JSON) ────────────────────────────────────
  router.get("/api/sessions/:id/export", async (ctx) => {
    const exported = await app.sessionManager.export(ctx.params.id)
    if (!exported) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`, ctx.corsHeaders)
      return
    }
    ok(ctx.res, exported, ctx.corsHeaders)
  })

  // ── Unified diff of session file changes ──────────────────────────────
  router.get("/api/sessions/:id/diff", async (ctx) => {
    const session = await app.sessionManager.load(ctx.params.id)
    if (!session) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`, ctx.corsHeaders)
      return
    }
    const diffs = session.fileChanges.map((c) => ({
      path: c.path,
      kind: c.kind,
      at: c.at,
      diff: unifiedDiffForFile(c.path, c.before, c.after),
    }))
    ok(ctx.res, { sessionId: ctx.params.id, diffs }, ctx.corsHeaders)
  })

  // ── Revert specific file changes (undo to before-state) ───────────────
  router.post("/api/sessions/:id/revert", async (ctx) => {
    const session = await app.sessionManager.load(ctx.params.id)
    if (!session) {
      notFound(ctx.res, `Session not found: ${ctx.params.id}`, ctx.corsHeaders)
      return
    }
    const targetPaths = Array.isArray(ctx.body.paths)
      ? (ctx.body.paths as string[]).map((p) => String(p))
      : undefined

    const restored: string[] = []
    const notFoundPaths: string[] = []
    // Revert in reverse order so later changes undo first.
    const changes = [...session.fileChanges].reverse()
    for (const change of changes) {
      if (targetPaths && !targetPaths.includes(change.path)) continue
      const abs = isAbsolute(change.path) ? change.path : resolve(app.cwd, change.path)
      // Workspace-bound + symlink-aware: never write outside the workspace.
      if (!(await isPathInWorkspace(abs, [app.cwd]))) {
        json(
          ctx.res,
          400,
          { error: `revert denied: ${change.path} is outside the workspace` },
          ctx.corsHeaders,
        )
        return
      }
      try {
        if (change.before !== undefined) {
          await writeFile(abs, change.before, "utf8")
          restored.push(change.path)
        } else {
          notFoundPaths.push(change.path)
        }
      } catch (err) {
        json(
          ctx.res,
          500,
          { error: `Failed to revert ${change.path}: ${(err as Error).message}` },
          ctx.corsHeaders,
        )
        return
      }
    }
    for (const p of restored) {
      app.bus.emit({
        kind: "file.changed",
        sessionId: ctx.params.id,
        data: { path: p, changeKind: "revert" },
      })
    }
    ok(ctx.res, { restored, missingBefore: notFoundPaths }, ctx.corsHeaders)
  })

  // ── Restore working tree to a snapshot (git-backed) ───────────────────
  router.post("/api/sessions/:id/restore", async (ctx) => {
    const snapshot = String(ctx.body.snapshot ?? "")
    if (!snapshot) {
      badRequest(ctx.res, "snapshot is required", ctx.corsHeaders)
      return
    }
    try {
      await getSnapshotService().restore(app.cwd, snapshot)
      ok(ctx.res, { restored: snapshot }, ctx.corsHeaders)
    } catch (err) {
      json(ctx.res, 500, { error: `Restore failed: ${(err as Error).message}` }, ctx.corsHeaders)
    }
  })

  // ── Edit a message's content ──────────────────────────────────────────
  router.patch("/api/sessions/:id/messages/:messageId", async (ctx) => {
    const content = String(ctx.body.content ?? "")
    if (!content) {
      badRequest(ctx.res, "content is required", ctx.corsHeaders)
      return
    }
    const updated = await app.sessionManager.editMessage(
      ctx.params.id,
      ctx.params.messageId,
      content,
    )
    if (!updated) {
      notFound(ctx.res, `Session or message not found`, ctx.corsHeaders)
      return
    }
    ok(ctx.res, { session: updated }, ctx.corsHeaders)
  })

  // ── Retry: truncate to last user message and re-run ───────────────────
  router.post("/api/sessions/:id/retry", async (ctx) => {
    const prep = await app.sessionManager.retry(ctx.params.id)
    if (!prep) {
      badRequest(ctx.res, "No user message to retry", ctx.corsHeaders)
      return
    }
    const result = await runSessionPrompt(app, {
      sessionId: ctx.params.id,
      prompt: prep.query,
      async: true,
    })
    if (result.status === "running") {
      accepted(ctx.res, result, ctx.corsHeaders)
      return
    }
    ok(ctx.res, result, ctx.corsHeaders)
  })

  // ── Run agent (POST /api/sessions/:id/prompt) ──────────────────────────
  router.post("/api/sessions/:id/prompt", async (ctx) => {
    const sessionId = ctx.params.id
    let query = String(ctx.body.prompt ?? ctx.body.query ?? "")
    if (!query.trim()) {
      badRequest(ctx.res, "prompt is required")
      return
    }

    // Extract external file references (@path patterns) from the prompt.
    // The agent loop will read these and inject their content into context.
    const refs = extractRefs(query)
    if (refs.length > 0) {
      // Strip the @path references from the query so the model sees clean text.
      // The file content is injected as a separate context block.
      for (const ref of refs) {
        query = query.replace(`@${ref}`, ref)
      }
    }

    const waitForCompletion = ctx.body.async === false || ctx.query.wait === "true"
    const maxSteps = ctx.body.maxSteps ? Number(ctx.body.maxSteps) : undefined
    const temperature = typeof ctx.body.temperature === "number" ? ctx.body.temperature : undefined

    const result = await runSessionPrompt(app, {
      sessionId,
      prompt: query,
      maxSteps,
      temperature,
      refs: refs.length > 0 ? refs : undefined,
      async: !waitForCompletion,
    })

    if (result.status === "running") {
      accepted(ctx.res, result)
      return
    }

    if (result.status === "error") {
      json(ctx.res, 500, { error: result.error ?? "Agent run failed", ...result })
      return
    }

    ok(ctx.res, result)
  })
}
