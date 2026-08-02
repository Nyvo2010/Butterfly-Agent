/**
 * MCP route group — list, connect, and disconnect Model Context Protocol servers.
 */

import type { ButterflyMCPConfig } from "@butterfly/core"
import type { ServerApp } from "../app"
import { createMCPIntegration } from "../integrations/mcp"
import type { Router } from "../router"
import { badRequest, created, notFound, ok } from "../router"

function parseMcpConfigFromBody(body: Record<string, unknown>): ButterflyMCPConfig {
  const command = body.command as string | undefined
  const url = body.url as string | undefined
  if (!command && !url) {
    throw new Error("MCP config requires command or url")
  }
  return {
    command: command ?? "",
    url,
    args: Array.isArray(body.args) ? (body.args as string[]) : undefined,
    env:
      typeof body.env === "object" && body.env !== null
        ? (body.env as Record<string, string>)
        : undefined,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    headers:
      typeof body.headers === "object" && body.headers !== null
        ? (body.headers as Record<string, string>)
        : undefined,
  }
}

async function ensureMcpIntegration(
  app: ServerApp,
): Promise<NonNullable<ReturnType<ServerApp["integrations"]["getMcp"]>>> {
  await app.ready()
  let mcp = app.integrations.getMcp()
  if (!mcp) {
    mcp = await createMCPIntegration({ config: app.butterflyConfig, bus: app.bus })
    app.integrations.setMcp(mcp)
  }
  return mcp
}

export function registerMCPRoutes(router: Router, app: ServerApp): void {
  router.get("/api/mcp", async (ctx) => {
    await app.ready()
    const mcpConfig = app.butterflyConfig.mcp ?? {}
    const live = app.integrations.getMcp()?.status() ?? []
    const liveByName = new Map(live.map((s) => [s.name, s]))

    type ServerView = {
      name: string
      command?: string
      url?: string
      args?: string[]
      connected: boolean
      toolCount: number
      error?: string
    }
    const servers: ServerView[] = Object.entries(mcpConfig).map(([name, config]) => {
      const status = liveByName.get(name)
      return {
        name,
        command: config.command,
        url: config.url,
        args: config.args,
        connected: status?.connected ?? false,
        toolCount: status?.toolCount ?? 0,
        error: status?.error,
      }
    })

    for (const status of live) {
      if (!servers.some((s) => s.name === status.name)) {
        servers.push({
          name: status.name,
          command: undefined,
          url: undefined,
          args: undefined,
          connected: status.connected,
          toolCount: status.toolCount,
          error: status.error,
        })
      }
    }

    ok(ctx.res, { servers }, ctx.corsHeaders)
  })

  /** Connect MCP server from config or request body (runtime registration). */
  router.post("/api/mcp/connect", async (ctx) => {
    const name = String(ctx.body.name ?? "")
    if (!name) {
      badRequest(ctx.res, "name is required", ctx.corsHeaders)
      return
    }
    let config: ButterflyMCPConfig
    try {
      config = app.butterflyConfig.mcp?.[name] ?? parseMcpConfigFromBody(ctx.body)
    } catch (err) {
      badRequest(ctx.res, (err as Error).message, ctx.corsHeaders)
      return
    }

    const mcp = await ensureMcpIntegration(app)
    const status = await mcp.connect(name, config)
    created(ctx.res, { server: status }, ctx.corsHeaders)
  })

  router.post("/api/mcp/:name/connect", async (ctx) => {
    const name = ctx.params.name
    let config: ButterflyMCPConfig
    try {
      config =
        app.butterflyConfig.mcp?.[name] ??
        (Object.keys(ctx.body).length > 0
          ? parseMcpConfigFromBody(ctx.body)
          : (() => {
              throw new Error("Provide MCP config in body or .butterfly/config.json")
            })())
    } catch (err) {
      badRequest(ctx.res, (err as Error).message, ctx.corsHeaders)
      return
    }

    const mcp = await ensureMcpIntegration(app)
    const status = await mcp.connect(name, config)
    ok(ctx.res, { server: status }, ctx.corsHeaders)
  })

  router.post("/api/mcp/:name/disconnect", async (ctx) => {
    await app.ready()
    const name = ctx.params.name
    const mcp = app.integrations.getMcp()
    if (!mcp) {
      badRequest(ctx.res, "No MCP servers connected", ctx.corsHeaders)
      return
    }
    const disconnected = await mcp.disconnect(name)
    if (!disconnected) {
      notFound(ctx.res, `MCP server not connected: ${name}`, ctx.corsHeaders)
      return
    }
    ok(ctx.res, { disconnected: true, name }, ctx.corsHeaders)
  })
}
