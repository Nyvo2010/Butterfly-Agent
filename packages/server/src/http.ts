/**
 * Butterfly HTTP server — assembles all route groups into a node:http server.
 *
 * Inspired by OpenCode's HttpApiApp composition: route modules register
 * themselves on a Router, middleware handles cross-cutting concerns (CORS,
 * body parsing, errors), and the server delegates to the router.
 *
 * This is the network boundary — all logic lives in route modules + ServerApp.
 */

import { createServer, type IncomingMessage } from "node:http"
import type { ServerApp } from "./app"
import { CORS_HEADERS, json, type RouteContext, Router, serverError } from "./router"
import { registerConfigRoutes } from "./routes/config"
import { registerEventRoutes } from "./routes/event"
import { registerFileRoutes } from "./routes/file"
import { registerMCPRoutes } from "./routes/mcp"
import { registerPermissionRoutes } from "./routes/permission"
import { registerProviderRoutes } from "./routes/provider"
import { registerSessionRoutes } from "./routes/session"

const MAX_BODY_BYTES = 1_000_000

/** Parse a JSON request body with a size limit. */
async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

export interface HttpServerOptions {
  /** Port to listen on (default 3000 or PORT env var). */
  port?: number
  /** Host to bind (default 127.0.0.1). */
  host?: string
}

export interface HttpServerHandle {
  /** The underlying http.Server. */
  server: ReturnType<typeof createServer>
  /** Stop the server. */
  close: () => Promise<void>
}

/**
 * Create and start the Butterfly HTTP server with all routes registered.
 *
 * Route groups:
 *   - /api/sessions/*  — session CRUD, prompt, fork, abort, messages
 *   - /api/event       — global SSE event stream
 *   - /api/file/*      — read-only file browsing
 *   - /api/config/*    — config read
 *   - /api/mcp         — MCP server status
 *   - /api/providers   — provider list
 *   - /api/permission  — permission request management
 *   - /health          — health check
 */
export function createHttpServer(app: ServerApp, _opts: HttpServerOptions = {}): HttpServerHandle {
  const router = new Router()

  // Register all route groups.
  registerSessionRoutes(router, app)
  registerEventRoutes(router, app)
  registerFileRoutes(router, app)
  registerConfigRoutes(router, app)
  registerMCPRoutes(router, app)
  registerProviderRoutes(router, app)
  registerPermissionRoutes(router, app)

  // ── Health check (outside the router, handled inline) ──────────────────
  router.get("/health", (ctx) => {
    json(ctx.res, 200, {
      status: "ok",
      uptime: process.uptime(),
      activeRuns: app.runState.count(),
      model: app.butterflyConfig.model ?? "default",
      routes: router.size(),
    })
  })

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS).end()
      return
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
    const pathname = url.pathname
    const method = req.method || "GET"
    const query: Record<string, string> = {}
    for (const [key, value] of url.searchParams) {
      query[key] = value
    }

    try {
      // Parse body for methods that have one.
      let body: Record<string, unknown> = {}
      if (method === "POST" || method === "PATCH" || method === "PUT") {
        body = await parseBody(req)
      }

      const ctx: RouteContext & { pathname: string } = {
        req,
        res,
        params: {},
        query,
        body,
        pathname,
      }

      const matched = await router.dispatch(ctx)
      if (!matched) {
        json(res, 404, { error: `Not found: ${method} ${pathname}` })
      }
    } catch (err) {
      if (!res.headersSent) {
        serverError(res, (err as Error).message)
      }
    }
  })

  return {
    server,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/**
 * Start the HTTP server listening on the given port.
 * Returns the HttpServerHandle once listening.
 */
export function startHttpServer(
  app: ServerApp,
  opts: HttpServerOptions = {},
): Promise<HttpServerHandle> {
  return new Promise((resolve, reject) => {
    const handle = createHttpServer(app, opts)
    const port = (opts.port ?? Number(process.env.PORT)) || 3_000
    const host = opts.host ?? "127.0.0.1"

    handle.server.listen(port, host, () => {
      process.stderr.write(`\n🦋 Butterfly Server running at http://${host}:${port}\n`)
      process.stderr.write(`   Health:    http://${host}:${port}/health\n`)
      process.stderr.write(`   Event:     http://${host}:${port}/api/event\n`)
      process.stderr.write(`   Sessions:  http://${host}:${port}/api/sessions\n\n`)
      resolve(handle)
    })

    handle.server.on("error", (err) => {
      reject(err)
    })
  })
}
