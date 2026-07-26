import type { ButterflyMCPConfig } from "@butterfly/core"
import { log } from "@butterfly/core"
import type { Tool, ToolContext, ToolResult } from "./types"

async function loadMCPSDK(): Promise<Record<string, unknown>> {
  try {
    // @ts-expect-error - optional dependency; may not be installed
    return (await import("@modelcontextprotocol/sdk")) as Record<string, unknown>
  } catch {
    throw new Error(
      "MCP integration requires '@modelcontextprotocol/sdk'. Install it with: " +
        "pnpm add @modelcontextprotocol/sdk",
    )
  }
}

interface MCPServerConnection {
  name: string
  client: unknown
  transport: unknown
  tools: Tool[]
}

const connections = new Map<string, MCPServerConnection>()

function wrapMCPTool(
  serverName: string,
  mcpTool: { name: string; description?: string; inputSchema: Record<string, unknown> },
  kind: Tool["kind"],
): Tool {
  return {
    name: `mcp_${serverName}_${mcpTool.name}`,
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name} (from ${serverName})`,
    kind,
    inputSchema: mcpTool.inputSchema ?? {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const conn = connections.get(serverName)
      if (!conn) return { kind: "err", message: `MCP server ${serverName} not connected` }
      try {
        const client = conn.client as {
          callTool?: (opts: {
            name: string
            arguments: Record<string, unknown>
          }) => Promise<{ content: Array<{ type: string; text?: string }> }>
        }
        if (typeof client.callTool !== "function") {
          return { kind: "err", message: `MCP client for ${serverName} does not support callTool` }
        }
        const result = await client.callTool({ name: mcpTool.name, arguments: input })
        const text = result.content.map((c) => c.text ?? "").join("\n")
        return { kind: "ok", output: text }
      } catch (err) {
        return { kind: "err", message: `MCP tool ${mcpTool.name} error: ${(err as Error).message}` }
      }
    },
  }
}

function createTransport(sdk: Record<string, unknown>, config: ButterflyMCPConfig): unknown {
  if (config.url) {
    const StreamableHTTPClientTransport = sdk.StreamableHTTPClientTransport as
      | { new (opts: { url: string; headers?: Record<string, string> }): unknown }
      | undefined
    if (!StreamableHTTPClientTransport) {
      throw new Error(
        "MCP SDK does not support StreamableHTTPClientTransport. Upgrade @modelcontextprotocol/sdk.",
      )
    }
    return new StreamableHTTPClientTransport({
      url: config.url,
      headers: config.headers,
    })
  }
  if (config.command) {
    const StdioClientTransport = sdk.StdioClientTransport as
      | {
          new (opts: {
            command: string
            args?: string[]
            env?: Record<string, string>
            cwd?: string
          }): unknown
        }
      | undefined
    if (!StdioClientTransport) {
      throw new Error(
        "MCP SDK does not support StdioClientTransport. Upgrade @modelcontextprotocol/sdk.",
      )
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env ? ({ ...config.env } as Record<string, string>) : undefined,
      cwd: config.cwd,
    })
  }
  throw new Error(`MCP server must have either "command" or "url" configured.`)
}

function createMCPClient(
  sdk: Record<string, unknown>,
  transport: unknown,
): {
  connect: (transport: unknown) => Promise<void>
  listTools: () => Promise<{
    tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
  }>
  close: () => Promise<void>
} {
  const Client = sdk.Client as
    | {
        new (
          opts: { name: string; version: string },
          transport: unknown,
        ): {
          connect: (transport: unknown) => Promise<void>
          listTools: () => Promise<{
            tools: Array<{
              name: string
              description?: string
              inputSchema: Record<string, unknown>
            }>
          }>
          close: () => Promise<void>
        }
      }
    | undefined
  if (!Client) {
    throw new Error("MCP SDK does not export Client. Upgrade @modelcontextprotocol/sdk.")
  }
  return new Client({ name: "butterfly", version: "0.1.0" }, transport)
}

export async function connectMCPServer(
  name: string,
  config: ButterflyMCPConfig,
  defaultKind?: Tool["kind"],
): Promise<Tool[]> {
  let transport: unknown = null
  try {
    const sdk = await loadMCPSDK()
    transport = createTransport(sdk, config)
    const client = createMCPClient(sdk, transport)
    await client.connect(transport)

    const { tools } = await client.listTools()
    const kind = defaultKind ?? "exec"
    const wrapped = tools.map((t) => wrapMCPTool(name, t, kind))

    connections.set(name, { name, client, transport, tools: wrapped })
    return wrapped
  } catch (err) {
    // Clean up the transport/process on connection failure to prevent leaks.
    if (transport) {
      try {
        const t = transport as { close?: () => Promise<void>; stop?: () => void }
        if (t.close) await t.close()
        else if (t.stop) t.stop()
      } catch {
        // Best-effort cleanup
      }
    }
    connections.delete(name)
    throw err
  }
}

export async function connectAllMCPServers(
  mcpConfig: Record<string, ButterflyMCPConfig>,
  defaultKind?: Tool["kind"],
): Promise<Tool[]> {
  const allTools: Tool[] = []
  for (const [serverName, config] of Object.entries(mcpConfig)) {
    if (connections.has(serverName)) continue
    try {
      const tools = await connectMCPServer(serverName, config, defaultKind)
      allTools.push(...tools)
    } catch (err) {
      log("error", `MCP server "${serverName}" failed to connect: ${(err as Error).message}`)
    }
  }
  return allTools
}

export function resetMCPConnections(): void {
  connections.clear()
}

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
