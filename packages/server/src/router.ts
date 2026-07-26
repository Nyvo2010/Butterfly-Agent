/**
 * Lightweight HTTP router for the Butterfly server.
 *
 * Uses node:http (no framework dependency) to stay consistent with the existing
 * server implementation. Supports path parameters (:id) and method-based
 * dispatch. Routes are registered by each route module and composed by http.ts.
 *
 * Inspired by OpenCode's modular route groups, but implemented with plain
 * Node primitives to keep the dependency surface minimal.
 */

import type { IncomingMessage, ServerResponse } from "node:http"

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "OPTIONS"

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  /** Path parameters extracted from the route pattern (e.g. :id). */
  params: Record<string, string>
  /** Parsed query string parameters. */
  query: Record<string, string>
  /** Parsed JSON body (for POST/PATCH/PUT). */
  body: Record<string, unknown>
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void

interface Route {
  method: HttpMethod
  /** Pattern with :param placeholders, e.g. "/api/sessions/:id". */
  pattern: string
  /** Pre-compiled regex + param names for matching. */
  regex: RegExp
  paramNames: string[]
  handler: RouteHandler
}

/** Convert a route pattern with :params into a regex + param name list. */
function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  // Split into segments by "/" so we can escape static segments without
  // corrupting the capture groups we insert for :params.
  const segments = pattern.split("/")
  const regexSegments = segments.map((seg) => {
    if (seg.startsWith(":")) {
      const name = seg.slice(1)
      paramNames.push(name)
      return "([^/]+)"
    }
    // Escape regex metacharacters in the static segment.
    return seg.replace(/[.+*?^${}()|[\]\\]/g, "\\$&")
  })
  return { regex: new RegExp(`^${regexSegments.join("/")}$`), paramNames }
}

export class Router {
  private readonly routes: Route[] = []

  /** Register a route handler. */
  add(method: HttpMethod, pattern: string, handler: RouteHandler): void {
    const { regex, paramNames } = compilePattern(pattern)
    this.routes.push({ method, pattern, regex, paramNames, handler })
  }

  get(pattern: string, handler: RouteHandler): void {
    this.add("GET", pattern, handler)
  }
  post(pattern: string, handler: RouteHandler): void {
    this.add("POST", pattern, handler)
  }
  patch(pattern: string, handler: RouteHandler): void {
    this.add("PATCH", pattern, handler)
  }
  delete(pattern: string, handler: RouteHandler): void {
    this.add("DELETE", pattern, handler)
  }
  put(pattern: string, handler: RouteHandler): void {
    this.add("PUT", pattern, handler)
  }

  /** Try to match a request. Returns the matched route + extracted params. */
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue
      const m = route.regex.exec(pathname)
      if (!m) continue
      const params: Record<string, string> = {}
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1] ?? "")
      })
      return { route, params }
    }
    return null
  }

  /** Dispatch a request. Returns true if a route matched. */
  async dispatch(ctx: Omit<RouteContext, "params"> & { pathname: string }): Promise<boolean> {
    const matched = this.match(ctx.req.method ?? "GET", ctx.pathname)
    if (!matched) return false
    await matched.route.handler({ ...ctx, params: matched.params })
    return true
  }

  /** Number of registered routes. */
  size(): number {
    return this.routes.length
  }
}

// ─── Response helpers ─────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS })
  res.end(JSON.stringify(data))
}

export function ok(res: ServerResponse, data: unknown): void {
  json(res, 200, data)
}

export function created(res: ServerResponse, data: unknown): void {
  json(res, 201, data)
}

export function notFound(res: ServerResponse, message: string): void {
  json(res, 404, { error: message })
}

export function badRequest(res: ServerResponse, message: string): void {
  json(res, 400, { error: message })
}

export function serverError(res: ServerResponse, message: string): void {
  json(res, 500, { error: message })
}

export { CORS_HEADERS }
