/**
 * MCP integration — connect configured servers and emit lifecycle events on the bus.
 */

import type { ButterflyConfig, ButterflyMCPConfig } from "@butterfly/core"
import { log } from "@butterfly/core"
import {
  connectAllMCPServers,
  connectMCPServer,
  disconnectAllMCPServers,
  disconnectMCPServer,
  isMCPConnected,
  listMCPServerStatus,
  type MCPServerStatus,
} from "@butterfly/tools"
import type { EventBus } from "../bus"

export type { MCPServerStatus }

export interface MCPIntegrationOptions {
  config: ButterflyConfig
  bus: EventBus
}

export interface MCPIntegrationResult {
  tools: import("@butterfly/tools").Tool[]
  status: () => MCPServerStatus[]
  connect: (name: string, config: ButterflyMCPConfig) => Promise<MCPServerStatus>
  disconnect: (name: string) => Promise<boolean>
  dispose: () => Promise<void>
}

/**
 * Connect all MCP servers from config. Idempotent — reuses existing connections.
 */
export async function createMCPIntegration(
  opts: MCPIntegrationOptions,
): Promise<MCPIntegrationResult> {
  const mcpConfig = opts.config.mcp ?? {}
  const tools = await connectAllMCPServers(mcpConfig, "exec", {
    onConnected: (name, toolCount) => {
      opts.bus.emit({ kind: "mcp.connected", data: { server: name, toolCount } })
      log("info", "integrations.mcp.connected", { name, toolCount })
    },
    onError: (name, message) => {
      opts.bus.emit({ kind: "mcp.error", data: { server: name, message } })
    },
  })

  return {
    tools,
    status: () => listMCPServerStatus(Object.keys(mcpConfig)),
    connect: async (name, config) => {
      if (isMCPConnected(name)) {
        return listMCPServerStatus([name])[0] ?? { name, connected: true, toolCount: 0 }
      }
      try {
        const connectedTools = await connectMCPServer(name, config, "exec")
        opts.bus.emit({
          kind: "mcp.connected",
          data: { server: name, toolCount: connectedTools.length },
        })
        return { name, connected: true, toolCount: connectedTools.length }
      } catch (err) {
        const message = (err as Error).message
        opts.bus.emit({ kind: "mcp.error", data: { server: name, message } })
        return { name, connected: false, toolCount: 0, error: message }
      }
    },
    disconnect: async (name) => {
      const removed = await disconnectMCPServer(name)
      if (removed) {
        opts.bus.emit({ kind: "mcp.disconnected", data: { server: name } })
      }
      return removed
    },
    dispose: async () => {
      await disconnectAllMCPServers()
    },
  }
}
