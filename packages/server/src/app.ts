/**
 * ServerApp — the shared application core for the Butterfly server.
 *
 * Inspired by OpenCode's instance/server architecture: instead of each entry
 * point (HTTP server, ACP agent) independently loading config + creating
 * tokenizer/store/llm/calling createAgent, they all construct a single
 * ServerApp that owns the heavy shared resources and exposes a unified API.
 *
 * Responsibilities:
 *   - Load config + butterfly config from disk
 *   - Create and warm the shared tokenizer
 *   - Create the shared LLM client
 *   - Own the SessionStore + SessionManager
 *   - Own the EventBus (decoupled publish/subscribe)
 *   - Own the RunStateManager (live run tracking)
 *   - Create per-run agents via @butterfly/agent's createAgent
 *
 * The HTTP layer (http.ts) and ACP layer (packages/acp) both use ServerApp.
 * This is the single source of truth for "what does the server own" — the
 * client owns nothing but UI.
 */

import type { AgentEventSink, AgentFactoryResult } from "@butterfly/agent"
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
import { FileSystemSessionStore } from "@butterfly/session"
import { EventBus } from "./bus"
import { RunStateManager } from "./run-state"
import { SessionManager } from "./session-manager"

export interface ServerAppOptions {
  /** Working directory for the agent (defaults to process.cwd()). */
  cwd?: string
  /** Override the session store (defaults to FileSystemSessionStore). */
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
}

export interface CreateAgentOptions {
  /** Streaming callback for live UI updates. */
  onStreamEvent?: (event: import("@butterfly/llm").LLMStreamEvent) => void
  /** Callback after each iteration. */
  onIteration?: (session: import("@butterfly/session").SessionState, iteration: number) => void
  /** Human-in-the-loop callback for ask_user tool. */
  onAskUser?: (question: string, options?: string[]) => Promise<string | null>
  /** Extra tools to register (MCP tools, plugins). */
  extraTools?: import("@butterfly/tools").Tool[]
  /** Extra dispose callbacks. */
  extraDisposers?: Array<() => void | Promise<void>>
  /**
   * Session id for stream event correlation. When set, stream events
   * (text_delta, reasoning) emitted on the bus will carry this sessionId so
   * per-session SSE subscribers receive them.
   */
  sessionId?: string
}

/**
 * Adapter that bridges the agent loop's AgentEventSink interface to the
 * server's EventBus. The loop emits flat { kind, sessionId, data } events;
 * this adapter wraps them into typed ButterflyEvent payloads.
 */
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
  readonly sessionManager: SessionManager
  readonly runState: RunStateManager

  constructor(opts: ServerAppOptions = {}) {
    this.cwd = opts.cwd ?? process.env.BUTTERFLY_CWD ?? process.cwd()

    // Initialize in order: env → config → tokenizer → store → LLM → managers.
    this.initEnv()
    this.config = opts.config ?? this.initConfig()
    this.butterflyConfig = opts.butterflyConfig ?? loadButterflyConfig(this.cwd)
    this.tokenizer = this.initTokenizer()
    this.store = opts.store ?? new FileSystemSessionStore()
    this.providerService = opts.providerService ?? this.initProviderService()
    this.llm = opts.llm ?? this.initLLMClient()
    this.bus = opts.bus ?? new EventBus()
    this.sessionManager = new SessionManager(this.store, this.bus)
    this.runState = new RunStateManager(this.bus)

    log("info", "server_app.init", {
      cwd: this.cwd,
      model: this.butterflyConfig.model ?? "default",
      providers: this.butterflyConfig.providers
        ? Object.keys(this.butterflyConfig.providers)
        : ["env"],
    })
  }

  // ── Initialization helpers (extracted from constructor) ─────────────────

  /** Load .env files from workspace root and cwd. */
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

  /** Load and apply the base config from environment. */
  private initConfig(): Config {
    const config = loadConfig()
    setLogLevel(config.agent.logLevel)
    return config
  }

  /** Create and warm the GPT tokenizer. */
  private initTokenizer(): GPTTokenizer {
    const tokenizer = new GPTTokenizer()
    tokenizer.warmup()
    return tokenizer
  }

  /** Create the ProviderService for dynamic model selection. */
  private initProviderService(): ProviderService {
    return new ProviderService(this.config.llm, this.butterflyConfig.providers)
  }

  /** Create the default LLM client for backward compat. */
  private initLLMClient(): LLMClient | undefined {
    const model = this.butterflyConfig.model ?? ""
    return createClient(model, this.config.llm, this.butterflyConfig.providers)
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Create a per-run agent with all standard tools wired.
   * The agent loop's bus is wired to the ServerApp's EventBus so events flow
   * to all subscribers (HTTP /event SSE clients, etc.).
   *
   * The caller is responsible for disposing the agent when the run completes.
   */
  async createAgent(runOpts: CreateAgentOptions = {}): Promise<AgentFactoryResult> {
    const sessionId = runOpts.sessionId
    return createAgent({
      cwd: this.cwd,
      llm: this.llm,
      providerService: this.providerService,
      tokenizer: this.tokenizer,
      store: this.store,
      config: this.butterflyConfig,
      bus: createBusSink(this.bus),
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
      extraTools: runOpts.extraTools,
      extraDisposers: runOpts.extraDisposers,
    })
  }

  /** Shut down all resources (abort runs, clear bus). */
  async dispose(): Promise<void> {
    this.runState.abortAll()
    this.bus.clear()
    log("info", "server_app.dispose")
  }
}
