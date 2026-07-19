/**
 * MCP (Model Context Protocol) client integration for Butterfly.
 *
 * Connects to MCP servers defined in butterfly.json, discovers their tools,
 * and wraps them as Butterfly Tool objects that the agent can use.
 *
 * Uses @modelcontextprotocol/sdk for the client implementation.
 * Supports both stdio (local) and SSE/HTTP (remote) transports.
 */

import type { Tool, ToolContext, ToolResult } from "./types"
import type { ButterflyMCPConfig } from "@butterfly/core"

// Lazy-load the MCP SDK to avoid requiring it at import time.
// Only loaded when MCP servers are actually configured.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadMCPSDK(): Promise<Record<string, any>> {
  try {
    // @ts-expect-error - @modelcontextprotocol/sdk is optional, installed on demand
    return await import("@modelcontextprotocol/sdk")
  } catch {
    throw new Error(
      "MCP integration requires @modelcontextprotocol/sdk. Install it with: " +
        "pnpm add @modelcontextprotocol/sdk",
    )
  }
}

interface MCPServerConnection {
  name: string
  client: unknown // MCP Client instance
  transport: unknown // Transport instance
  tools: Tool[]
}

const connections = new Map<string, MCPServerConnection>()

/**
 * Wrap an MCP tool as a Butterfly Tool.
 */
function wrapMCPTool(serverName: string, mcpTool: { name: string; description?: string; inputSchema: Record<string, unknown> }): Tool {
  return {
    name: `mcp_${serverName}_${mcpTool.name}`,
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name} (from ${serverName})`,
    kind: "exec",
    inputSchema: mcpTool.inputSchema ?? { type: "object", properties: {}, additionalProperties: true },
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const conn = connections.get(serverName)
      if (!conn) return { kind: "err", message: `MCP server ${serverName} not connected` }
      try {
        const client = conn.client as { callTool: (opts: { name: string; arguments: Record<string, unknown> }) => Promise<{ content: Array<{ type: string; text?: string }> }> }
        const result = await client.callTool({ name: mcpTool.name, arguments: input })
        const text = result.content.map((c) => c.text ?? "").join("\n")
        return { kind: "ok", output: text }
      } catch (err) {
        return { kind: "err", message: `MCP tool ${mcpTool.name} error: ${(err as Error).message}` }
      }
    },
  }
}

/**
 * Connect to a single MCP server and discover its tools.
 */
export async function connectMCPServer(
  name: string,
  config: ButterflyMCPConfig,
): Promise<Tool[]> {
  const sdk = await loadMCPSDK()

  let transport: unknown
  if (config.url) {
    // Remote SSE transport
    const StreamableHTTPClientTransport = (sdk as Record<string, unknown>).StreamableHTTPClientTransport as
      | { new (opts: { url: string; headers?: Record<string, string> }): unknown }
      | undefined
    if (!StreamableHTTPClientTransport) {
      throw new Error("MCP SDK does not support StreamableHTTPClientTransport. Upgrade @modelcontextprotocol/sdk.")
    }
    transport = new StreamableHTTPClientTransport({
      url: config.url,
      headers: config.headers,
    })
  } else if (config.command) {
    // Local stdio transport
    const StdioClientTransport = (sdk as Record<string, unknown>).StdioClientTransport as
      | { new (opts: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }): unknown }
      | undefined
    if (!StdioClientTransport) {
      throw new Error("MCP SDK does not support StdioClientTransport. Upgrade @modelcontextprotocol/sdk.")
    }
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
      cwd: config.cwd,
    })
  } else {
    throw new Error(`MCP server "${name}" must have either "command" or "url" configured.`)
  }

  const Client = (sdk as Record<string, unknown>).Client as
    | { new (opts: { name: string; version: string }, transport: unknown): { connect: (transport: unknown) => Promise<void>; listTools: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>; close: () => Promise<void> } }
    | undefined
  if (!Client) {
    throw new Error("MCP SDK does not export Client. Upgrade @modelcontextprotocol/sdk.")
  }

  const client = new Client({ name: "butterfly", version: "0.1.0" }, transport)
  await client.connect(transport)

  const { tools } = await client.listTools()
  const wrapped = tools.map((t) => wrapMCPTool(name, t))

  connections.set(name, { name, client, transport, tools: wrapped })
  return wrapped
}

/**
 * Connect to all MCP servers defined in the config.
 * Returns all discovered tools ready for registration.
 */
export async function connectAllMCPServers(
  mcpConfig: Record<string, ButterflyMCPConfig>,
): Promise<Tool[]> {
  const allTools: Tool[] = []
  for (const [serverName, config] of Object.entries(mcpConfig)) {
    if (connections.has(serverName)) continue
    try {
      const tools = await connectMCPServer(serverName, config)
      allTools.push(...tools)
    } catch (err) {
      console.error(`[butterfly] MCP server "${serverName}" failed to connect: ${(err as Error).message}`)
    }
  }
  return allTools
}

/**
 * Disconnect all MCP servers. Call on shutdown.
 */
export async function disconnectAllMCPServers(): Promise<void> {
  for (const [, conn] of connections) {
    try {
      const client = conn.client as { close: () => Promise<void> }
      await client.close()
    } catch {
      // Best-effort disconnect
    }
  }
  connections.clear()
}
