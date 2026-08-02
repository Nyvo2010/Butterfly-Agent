/**
 * Server integrations — wires optional subsystems (store, LSP, MCP) at startup.
 *
 * Keeps ServerApp focused on lifecycle; new integrations register here.
 */

import type { ButterflyConfig } from "@butterfly/core"
import { log } from "@butterfly/core"
import type { SessionStore } from "@butterfly/session"
import type { LSPClientLike, Tool } from "@butterfly/tools"
import type { EventBus } from "../bus"
import { createLSPIntegration } from "./lsp"
import { createMCPIntegration, type MCPIntegrationResult } from "./mcp"
import { createSessionStore, resolveStoreBackend } from "./store"

export interface IntegrationsOptions {
  cwd: string
  config: ButterflyConfig
  bus: EventBus
  store?: SessionStore
}

export class Integrations {
  readonly store: SessionStore
  private lspClient: LSPClientLike | null = null
  private lspDispose: (() => Promise<void>) | null = null
  private mcp: MCPIntegrationResult | null = null
  private initPromise: Promise<void> | null = null

  constructor(opts: IntegrationsOptions) {
    this.store = opts.store ?? createSessionStore({ backend: resolveStoreBackend(process.env) })
  }

  /** Lazy-init LSP + MCP (async). Safe to call multiple times. */
  async initialize(opts: IntegrationsOptions): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInitialize(opts)
    return this.initPromise
  }

  private async doInitialize(opts: IntegrationsOptions): Promise<void> {
    const lsp = await createLSPIntegration({ cwd: opts.cwd, config: opts.config })
    this.lspClient = lsp.client
    this.lspDispose = lsp.dispose

    if (opts.config.mcp && Object.keys(opts.config.mcp).length > 0) {
      try {
        this.mcp = await createMCPIntegration({ config: opts.config, bus: opts.bus })
        log("info", "integrations.mcp.ready", {
          servers: this.mcp.status().filter((s) => s.connected).length,
          tools: this.mcp.tools.length,
        })
      } catch (err) {
        log("warn", "integrations.mcp.init_failed", { message: (err as Error).message })
      }
    }
  }

  getLspClient(): LSPClientLike | undefined {
    return this.lspClient ?? undefined
  }

  getMcpTools(): Tool[] {
    return this.mcp?.tools ?? []
  }

  getMcp(): MCPIntegrationResult | null {
    return this.mcp
  }

  /** Attach MCP integration after lazy runtime connect. */
  setMcp(mcp: MCPIntegrationResult): void {
    this.mcp = mcp
  }

  async dispose(): Promise<void> {
    if (this.mcp) await this.mcp.dispose()
    if (this.lspDispose) await this.lspDispose()
    this.mcp = null
    this.lspClient = null
    this.lspDispose = null
    this.initPromise = null
  }
}

export { createSessionStore, resolveStoreBackend } from "./store"
