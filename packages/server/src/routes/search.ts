/**
 * Search route group — lightweight code symbol search via the identifier index.
 *
 * GET /api/search?q=... — symbol-level search over the workspace.
 *   - Index is built lazily on first request (bounded, dependency-free).
 *   - ?refresh=true forces a rebuild (e.g. after the agent edits files).
 */

import type { ServerApp } from "../app"
import type { Router } from "../router"
import { badRequest, json, ok } from "../router"

const MAX_SEARCH_LIMIT = 100

export function registerSearchRoutes(router: Router, app: ServerApp): void {
  router.get("/api/search", async (ctx) => {
    const q = String(ctx.query.q ?? "").trim()
    if (!q) {
      badRequest(ctx.res, "q is required", ctx.corsHeaders)
      return
    }
    const limitRaw = Number.parseInt(ctx.query.limit ?? "50", 10)
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_SEARCH_LIMIT) : 50
    const refresh = ctx.query.refresh === "true"

    try {
      if (refresh || !app.indexer.isBuilt) {
        await app.indexer.build()
      }
      const results = app.indexer.search(q, limit)
      ok(
        ctx.res,
        {
          query: q,
          results,
          stats: app.indexer.statsView,
          indexBuilt: app.indexer.isBuilt,
        },
        ctx.corsHeaders,
      )
    } catch (err) {
      json(ctx.res, 500, { error: `Search failed: ${(err as Error).message}` }, ctx.corsHeaders)
    }
  })
}
