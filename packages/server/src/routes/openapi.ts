/**
 * OpenAPI spec export — generates a minimal-but-valid OpenAPI 3.0 document from
 * the registered routes. Mirrors OpenCode's `GET /openapi` endpoint: clients,
 * codegen, and tooling can consume the API surface without hand-maintained docs.
 *
 * Route patterns are converted to OpenAPI path templates (`:id` → `{id}`).
 */

import type { ServerApp } from "../app"
import type { Router } from "../router"
import { json } from "../router"

const SUMMARY: Record<string, string> = {
  "/api/sessions": "Session CRUD, prompt, fork, abort",
  "/api/event": "Global SSE event stream",
  "/api/file": "Read-only file browsing",
  "/api/config": "Configuration read",
  "/api/mcp": "MCP server status",
  "/api/mcp/:name/connect": "Connect an MCP server",
  "/api/mcp/:name/disconnect": "Disconnect an MCP server",
  "/api/providers": "Provider + model catalog",
  "/api/permission": "Permission request management",
  "/health": "Health check",
}

function patternToPath(pattern: string): string {
  // `/api/sessions/:id/messages` → `/api/sessions/{id}/messages`
  return pattern.replace(/:([A-Za-z0-9_]+)/g, "{$1}")
}

/** Build the OpenAPI 3.0 document for a Router. */
export function buildOpenApi(router: Router): Record<string, unknown> {
  const paths: Record<string, unknown> = {}

  for (const route of router.describe()) {
    const path = patternToPath(route.pattern)
    const method = route.method.toLowerCase()
    if (!paths[path]) paths[path] = {}
    ;(paths[path] as Record<string, unknown>)[method] = {
      summary: SUMMARY[route.pattern] ?? "Butterfly API endpoint",
      operationId: `${method}_${route.pattern.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      responses: {
        "200": { description: "OK" },
        "400": { description: "Bad request" },
        "404": { description: "Not found" },
        "500": { description: "Server error" },
      },
    }
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Butterfly Agent API",
      version: "0.1.0",
      description:
        "Butterfly Agent server API. The server owns all agent logic, session " +
        "state, and event broadcasting; clients are pure UI.",
    },
    servers: [{ url: "/", description: "Local Butterfly server" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
  }
}

export function registerOpenApiRoutes(router: Router, _app: ServerApp): void {
  // Public path (see auth.ts PUBLIC_PATHS) so clients can discover the API
  // surface before authenticating.
  router.get("/openapi.json", (ctx) => {
    json(ctx.res, 200, buildOpenApi(router))
  })
}
