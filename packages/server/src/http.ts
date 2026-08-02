/**
 * Butterfly HTTP server — assembles route groups + cross-cutting middleware.
 */

import { createServer, type IncomingMessage } from "node:http"
import type { ServerApp } from "./app"
import { checkRequestAuth, isPublicPath } from "./auth"
import { buildCorsHeaders } from "./http/config"
import { runRequestMiddleware } from "./http/middleware"
import { json, type RouteContext, Router, serverError } from "./router"
import { registerConfigRoutes } from "./routes/config"
import { registerEventRoutes } from "./routes/event"
import { registerFileRoutes } from "./routes/file"
import { registerMCPRoutes } from "./routes/mcp"
import { registerOpenApiRoutes } from "./routes/openapi"
import { registerPermissionRoutes } from "./routes/permission"
import { registerProviderRoutes } from "./routes/provider"
import { registerSearchRoutes } from "./routes/search"
import { registerSessionRoutes } from "./routes/session"

const MAX_BODY_BYTES = 1_000_000

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
  port?: number
  host?: string
}

export interface HttpServerHandle {
  server: ReturnType<typeof createServer>
  close: () => Promise<void>
}

export function createHttpServer(app: ServerApp, _opts: HttpServerOptions = {}): HttpServerHandle {
  const router = new Router()

  registerSessionRoutes(router, app)
  registerEventRoutes(router, app)
  registerFileRoutes(router, app)
  registerConfigRoutes(router, app)
  registerMCPRoutes(router, app)
  registerProviderRoutes(router, app)
  registerPermissionRoutes(router, app)
  registerSearchRoutes(router, app)
  registerOpenApiRoutes(router, app)

  router.get("/health", (ctx) => {
    json(
      ctx.res,
      200,
      {
        status: "ok",
        uptime: process.uptime(),
        activeRuns: app.runState.count(),
        model: app.butterflyConfig.model ?? "default",
        routes: router.size(),
        requestId: ctx.requestId,
      },
      ctx.corsHeaders,
    )
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
    const pathname = url.pathname
    const method = req.method || "GET"
    const query: Record<string, string> = {}
    for (const [key, value] of url.searchParams) {
      query[key] = value
    }

    const requestOrigin = req.headers.origin
    const origin = typeof requestOrigin === "string" ? requestOrigin : undefined
    const corsHeaders = buildCorsHeaders(app.httpConfig.cors, origin)

    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders).end()
      return
    }

    const middleware = runRequestMiddleware(req, res, pathname, app.httpConfig, corsHeaders)
    if (middleware.blocked) return

    if (!isPublicPath(pathname) && app.authConfig.enabled) {
      const authResult = checkRequestAuth(req.headers, app.authConfig)
      if (!authResult.authenticated) {
        json(
          res,
          401,
          { error: authResult.reason ?? "Unauthorized", requestId: middleware.requestId },
          corsHeaders,
        )
        return
      }
    }

    try {
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
        corsHeaders,
        requestId: middleware.requestId,
      }

      const matched = await router.dispatch(ctx)
      if (!matched) {
        json(
          res,
          404,
          { error: `Not found: ${method} ${pathname}`, requestId: middleware.requestId },
          corsHeaders,
        )
      }
    } catch (err) {
      if (!res.headersSent) {
        serverError(res, (err as Error).message, corsHeaders)
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
