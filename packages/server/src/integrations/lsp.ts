/**
 * LSP integration — optional StdioLSPClient bootstrap with per-language routing.
 */

import { NoOpLSPClient } from "@butterfly/agent"
import { StdioLSPClient } from "@butterfly/context"
import type { ButterflyConfig } from "@butterfly/core"
import { log } from "@butterfly/core"
import type { LSPClientLike } from "@butterfly/tools"
import { type LSPRoute, MultiLSPClient } from "./lsp-multi"

export interface LSPIntegrationOptions {
  cwd: string
  config: ButterflyConfig
  env?: Record<string, string | undefined>
}

export interface LSPIntegrationResult {
  client: LSPClientLike
  dispose: () => Promise<void>
}

function isEnabled(config: ButterflyConfig, env: Record<string, string | undefined>): boolean {
  if (env.BUTTERFLY_LSP === "0" || env.BUTTERFLY_LSP === "false") return false
  if (env.BUTTERFLY_LSP === "1" || env.BUTTERFLY_LSP === "true") return true
  return config.butterfly?.lsp?.enabled !== false
}

function parseCommand(raw: string | string[] | undefined): string[] | undefined {
  if (!raw) return undefined
  if (Array.isArray(raw)) return raw
  return raw.split(/\s+/).filter(Boolean)
}

function defaultTypeScriptCommand(): string[] {
  return ["npx", "--yes", "typescript-language-server@4.3.3", "--stdio"]
}

async function startServer(
  cwd: string,
  command: string[],
  timeoutMs?: number,
): Promise<{ client: StdioLSPClient; dispose: () => Promise<void> }> {
  const client = new StdioLSPClient(cwd, { serverCommand: command, timeout: timeoutMs })
  return {
    client,
    dispose: async () => {
      try {
        await client.shutdown()
      } catch (err) {
        log("warn", "integrations.lsp.shutdown_error", { message: (err as Error).message })
      }
    },
  }
}

/**
 * Create an LSP client. Soft-fails to NoOpLSPClient when disabled or on error.
 * Supports:
 *   - Single default server via butterfly.lsp.command
 *   - Per-language servers via butterfly.lsp.servers
 */
export async function createLSPIntegration(
  opts: LSPIntegrationOptions,
): Promise<LSPIntegrationResult> {
  const env = opts.env ?? process.env
  if (!isEnabled(opts.config, env)) {
    return { client: new NoOpLSPClient(), dispose: async () => {} }
  }

  const lspConfig = opts.config.butterfly?.lsp
  const timeoutMs = lspConfig?.timeoutMs
  const disposers: Array<() => Promise<void>> = []

  try {
    const routes: LSPRoute[] = []
    const servers = lspConfig?.servers ?? {}

    for (const [label, serverCfg] of Object.entries(servers)) {
      const command = parseCommand(serverCfg.command)
      if (!command || command.length === 0) continue
      try {
        const started = await startServer(opts.cwd, command, timeoutMs)
        disposers.push(started.dispose)
        routes.push({
          label,
          extensions: serverCfg.extensions ?? [],
          client: started.client,
        })
        log("info", "integrations.lsp.server_started", { label, extensions: serverCfg.extensions })
      } catch (err) {
        log("warn", "integrations.lsp.server_failed", { label, message: (err as Error).message })
      }
    }

    const defaultCommand =
      parseCommand(env.BUTTERFLY_LSP_COMMAND) ??
      parseCommand(lspConfig?.command) ??
      defaultTypeScriptCommand()

    const defaultStarted = await startServer(opts.cwd, defaultCommand, timeoutMs)
    disposers.push(defaultStarted.dispose)

    const client =
      routes.length > 0 ? new MultiLSPClient(routes, defaultStarted.client) : defaultStarted.client

    log("info", "integrations.lsp.ready", { cwd: opts.cwd, routes: routes.length })
    return {
      client,
      dispose: async () => {
        for (const d of disposers) await d()
      },
    }
  } catch (err) {
    for (const d of disposers) await d().catch(() => {})
    log("warn", "integrations.lsp.failed", { message: (err as Error).message })
    return { client: new NoOpLSPClient(), dispose: async () => {} }
  }
}
