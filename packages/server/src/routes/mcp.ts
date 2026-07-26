/**
 * MCP route group — manage Model Context Protocol server connections.
 *
 * The client can view connected MCP servers and connect/disconnect them.
 * Inspired by OpenCode's mcp route group. Actual tool registration happens via
 * @butterfly/tools' connectMCPServer; this route layer exposes status to the UI.
 */

import type { ServerApp } from "../app"
import type { Router } from "../router"
import { ok } from "../router"

export function registerMCPRoutes(router: Router, app: ServerApp): void {
  // ── List MCP server configurations ─────────────────────────────────────
  router.get("/api/mcp", (_ctx) => {
    const mcpConfig = app.butterflyConfig.mcp ?? {}
    const servers = Object.entries(mcpConfig).map(([name, config]) => ({
      name,
      command: config.command,
      url: config.url,
      args: config.args,
    }))
    ok(_ctx.res, { servers })
  })
}
