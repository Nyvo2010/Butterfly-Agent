/**
 * ServerApp — the shared application core for the Butterfly server.
 *
 * Inspired by OpenCode's instance/server architecture: instead of each entry
 * point (HTTP server, ACP agent) independently loading config + creating
 * tokenizer/store/llm/calling createAgent, they all construct a single
 * ServerApp that owns the heavy shared resources and exposes a unified API.
 */

import type { AgentEventSink, AgentFactoryResult, AskUserCallback } from "@butterfly/agent"
import { createAgent } from "@butterfly/agent"
import { GPTTokenizer } from "@butterfly/context"
import {
  type ButterflyConfig,
  type Config,
  findWorkspaceRoot,
  loadButterflyConfig,
  loadConfig,
  loadDotEnv,
  log,
  setLogLevel,
} from "@butterfly/core"
import { createClient, type LLMClient, ProviderService } from "@butterfly/llm"
import type { SessionStore } from "@butterfly/session"
import type { AuthConfig } from "./auth"
import { loadAuthConfig } from "./auth"
import { EventBus } from "./bus"
import { type HttpRuntimeConfig, loadHttpRuntimeConfig } from "./http/config"
import { CodeIndexer } from "./indexer"
import { Integrations } from "./integrations"
import { InMemoryPermissionStore, type PermissionStore } from "./permission-store"
import { RunStateManager } from "./run-state"
import { SessionManager } from "./session-manager"

export interface ServerAppOptions {
  /** Working directory for the agent (defaults to process.cwd()). */
  cwd?: string
  /** Override the session store (defaults to env-selected backend). */
  store?: SessionStore
  /** Override the LLM client (defaults to createClient from config). */
  llm?: LLMClient
  /** Override the provider service (defaults to ProviderService from config). */
  providerService?: ProviderService
  /** Override the base config (defaults to loadConfig from env). */
  config?: Config
  /** Override the butterfly config (defaults to loadButterflyConfig). */
  butterflyConfig?: ButterflyConfig
  /** Override the event bus (defaults to a new EventBus). */
  bus?: EventBus
  /** Override the auth config (defaults to loadAuthConfig from env). */
  authConfig?: AuthConfig
  /** Skip async integration bootstrap (LSP/MCP). For tests. */
  skipIntegrations?: boolean
  /** Override permission store (defaults to InMemoryPermissionStore). */
  permissionStore?: PermissionStore
  /** Override HTTP runtime config (CORS, rate limits). */
  httpConfig?: HttpRuntimeConfig
}

export interface CreateAgentOptions {
  /** Streaming callback for live UI updates. */
  onStreamEvent?: (event: import("@butterfly/llm").LLMStreamEvent) => void
  /** Callback after each iteration. */
  onIteration?: (session: import("@butterfly/session").SessionState, iteration: number) => void
  /** Human-in-the-loop callback for ask_user tool and permission prompts. */
  onAskUser?: AskUserCallback
  /** Extra tools to register beyond integrations (plugins, custom). */
  extraTools?: import("@butterfly/tools").Tool[]
  /** Extra dispose callbacks. */
  extraDisposers?: Array<() => void | Promise<void>>
  /**
   * Session id for stream event correlation. When set, stream events
   * emitted on the bus will carry this sessionId for per-session SSE subscribers.
   */
  sessionId?: string
}

function createBusSink(bus: EventBus): AgentEventSink {
  return {
    emit(event) {
      bus.emit(event as Parameters<typeof bus.emit>[0])
    },
  }
}

export class ServerApp {
  readonly cwd: string
  readonly config: Config
  readonly butterflyConfig: ButterflyConfig
  readonly tokenizer: GPTTokenizer
  readonly store: SessionStore
  readonly llm: LLMClient | undefined
  readonly providerService: ProviderService
  readonly bus: EventBus
  readonly authConfig: AuthConfig
  readonly sessionManager: SessionManager
  readonly runState: RunStateManager
  readonly integrations: Integrations
  readonly permissionStore: PermissionStore
  readonly httpConfig: HttpRuntimeConfig
  /** Lightweight code identifier index for /api/search. Built lazily on demand. */
  readonly indexer: CodeIndexer

  private readonly initPromise: Promise<void>

  constructor(opts: ServerAppOptions = {}) {
    this.cwd = opts.cwd ?? process.env.BUTTERFLY_CWD ?? process.cwd()

    this.initEnv()
    this.config = opts.config ?? this.initConfig()
    this.butterflyConfig = opts.butterflyConfig ?? loadButterflyConfig(this.cwd)
    this.tokenizer = this.initTokenizer()
    this.bus = opts.bus ?? new EventBus()
    this.integrations = new Integrations({
      cwd: this.cwd,
      config: this.butterflyConfig,
      bus: this.bus,
      store: opts.store,
    })
    this.store = this.integrations.store
    this.providerService = opts.providerService ?? this.initProviderService()
    this.llm = opts.llm ?? this.initLLMClient()
    this.authConfig = opts.authConfig ?? loadAuthConfig(process.env, this.butterflyConfig.apiKey)
    this.sessionManager = new SessionManager(this.store, this.bus)
    this.runState = new RunStateManager(this.bus)
    this.permissionStore = opts.permissionStore ?? new InMemoryPermissionStore()
    this.httpConfig = opts.httpConfig ?? loadHttpRuntimeConfig(process.env)
    this.indexer = new CodeIndexer(this.cwd)

    this.initPromise = opts.skipIntegrations
      ? Promise.resolve()
      : this.integrations.initialize({
          cwd: this.cwd,
          config: this.butterflyConfig,
          bus: this.bus,
          store: this.store,
        })

    log("info", "server_app.init", {
      cwd: this.cwd,
      model: this.butterflyConfig.model ?? "default",
      providers: this.butterflyConfig.providers
        ? Object.keys(this.butterflyConfig.providers)
        : ["env"],
    })
  }

  /** Wait until LSP/MCP integrations have finished bootstrapping. */
  async ready(): Promise<void> {
    await this.initPromise
    // Sweep persisted active-run markers left behind by a previous crash/restart
    // so /status reports honest state. Idempotent + cheap (only loads sessions
    // that carry the marker flag from the store list).
    await this.recoverInterruptedRuns()
  }

  /**
   * Detect and clear persisted active-run markers after a restart.
   * Emits run.recovered events per session. Safe to call repeatedly.
   */
  async recoverInterruptedRuns(): Promise<number> {
    return this.runState.recoverFromStore(this.store)
  }

  private initEnv(): void {
    const root = findWorkspaceRoot(this.cwd)
    const envPaths = [`${root}/.env`, `${this.cwd}/.env`]
    let loaded = false
    for (const p of envPaths) {
      if (loadDotEnv(p) > 0) {
        loaded = true
        break
      }
    }
    if (!loaded) {
      loadDotEnv(`${findWorkspaceRoot(import.meta.dirname ?? this.cwd)}/.env`)
    }
  }

  private initConfig(): Config {
    const config = loadConfig()
    setLogLevel(config.agent.logLevel)
    return config
  }

  private initTokenizer(): GPTTokenizer {
    const tokenizer = new GPTTokenizer()
    tokenizer.warmup()
    return tokenizer
  }

  private initProviderService(): ProviderService {
    return new ProviderService(this.config.llm, this.butterflyConfig.providers)
  }

  private initLLMClient(): LLMClient | undefined {
    const model = this.butterflyConfig.model ?? ""
    return createClient(model, this.config.llm, this.butterflyConfig.providers)
  }

  /**
   * Create a per-run agent with standard tools + integrations (LSP, MCP) wired.
   * The agent loop's bus is wired to the ServerApp EventBus.
   */
  async createAgent(runOpts: CreateAgentOptions = {}): Promise<AgentFactoryResult> {
    await this.ready()

    const sessionId = runOpts.sessionId
    const mcpTools = this.integrations.getMcpTools()
    const extraTools = [...mcpTools, ...(runOpts.extraTools ?? [])]

    return createAgent({
      cwd: this.cwd,
      llm: this.llm,
      providerService: this.providerService,
      tokenizer: this.tokenizer,
      store: this.store,
      config: this.butterflyConfig,
      lspClient: this.integrations.getLspClient(),
      bus: createBusSink(this.bus),
      extraTools,
      extraDisposers: runOpts.extraDisposers,
      onStreamEvent: (event) => {
        if (event.kind === "text_delta") {
          this.bus.emit({ kind: "stream.text_delta", sessionId, data: { text: event.text } })
        } else if (event.kind === "reasoning_delta") {
          this.bus.emit({ kind: "stream.reasoning", sessionId, data: { text: event.text } })
        }
        runOpts.onStreamEvent?.(event)
      },
      onIteration: (session, iteration) => {
        runOpts.onIteration?.(session, iteration)
      },
      onAskUser: runOpts.onAskUser,
    })
  }

  async dispose(): Promise<void> {
    this.runState.abortAll()
    await this.integrations.dispose()
    this.permissionStore.clear()
    this.bus.clear()
    log("info", "server_app.dispose")
  }
}
