/**
 * Shared agent factory — creates a fully wired Butterfly AgentLoop.
 *
 * This eliminates code duplication across the CLI, server, and ACP packages.
 * All consumers call `createAgent()` with their specific options to get a
 * ready-to-use agent loop with all standard tools registered.
 *
 * Separation of concerns:
 *   - This factory: agent setup (tools, LLM, router, monitors)
 *   - CLI/ACP/Server: transport-specific concerns (streaming, ask user, HTTP)
 */

import { COE, type GPTTokenizer, SCE } from "@butterfly/context"
import { type ButterflyConfig, DEFAULT_CONFIG, detectProject, log } from "@butterfly/core"
import {
  ForgivingToolCallParser,
  type LLMClient,
  type LLMStreamEvent,
  type ProviderService,
} from "@butterfly/llm"
import type { FileChange, SessionState, SessionStore, TodoItem } from "@butterfly/session"
import type { LSPClientLike } from "@butterfly/tools"
import {
  activateAllPlugins,
  applyPatchTool,
  bashTool,
  createLspTool,
  createRollbackTool,
  createSearchTool,
  createSkillTool,
  createSubagentTool,
  createTodowriteTool,
  deactivateAllPlugins,
  deleteTool,
  diffPatchTool,
  discoverSkills,
  formatSkillsForPrompt,
  globTool,
  grepTool,
  listTool,
  patchTool,
  planExitTool,
  questionTool,
  readTool,
  type ToolRegistry,
  ToolRegistry as ToolRegistryClass,
  webFetchTool,
  webSearchTool,
  writeTool,
} from "@butterfly/tools"
import { startBackgroundJobs } from "./jobs"
import { type AgentEventSink, AgentLoop } from "./loop"
import { buildPermissionHook } from "./permission"
import { QualityMonitor } from "./quality-monitor"
import { ModelRouter } from "./router"
import { getSnapshotService } from "./snapshot"
import { Subagent } from "./subagent"

/**
 * No-op LSP client — returns "not available" for all operations.
 * Used as default until a real LSP client is wired by the CLI/server.
 */
class NoOpLSPClient implements LSPClientLike {
  async goToDefinition() {
    return []
  }
  async findReferences() {
    return []
  }
  async hover() {
    return null
  }
  async getDocumentSymbols() {
    return []
  }
  async getDiagnostics() {
    return []
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentFactoryOptions {
  /** Working directory for the agent. */
  cwd: string
  /**
   * LLM client instance (backward compat). When not set, providerService
   * is used for dynamic model selection. At least one of llm or
   * providerService must be provided.
   */
  llm?: LLMClient
  /**
   * Provider service for dynamic model selection (OpenCode-compatible).
   * When set, the loop creates LLM clients on demand based on the
   * session's selectedModel. Takes precedence over `llm` when both are set.
   */
  providerService?: ProviderService
  /** Tokenizer instance shared across SCE/COE. */
  tokenizer: GPTTokenizer
  /** Session store for persistence. */
  store: SessionStore
  /** Butterfly config from disk. */
  config: ButterflyConfig
  /** Permission hook for destructive operations. */
  permissionHook?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{ allowed: boolean; reason?: string }>
  /** Streaming callback for live UI updates. */
  onStreamEvent?: (event: LLMStreamEvent) => void
  /** Callback after each iteration. */
  onIteration?: (session: SessionState, iteration: number) => void
  /** Human-in-the-loop callback for ask_user tool. */
  onAskUser?: (question: string, options?: string[]) => Promise<string | null>
  /**
   * Optional event sink for decoupled event publishing (server event bus).
   * When set, the loop emits tool/file/stream events through it so external
   * subscribers (HTTP /event SSE clients, etc.) can observe without coupling.
   */
  bus?: AgentEventSink

  /**
   * Optional LSP client for code intelligence (go-to-definition, find-references, etc.).
   * When not set, the LSP tool returns a friendly "LSP not available" message.
   * Pass StdioLSPClient from @butterfly/context for real LSP support.
   */
  lspClient?: import("@butterfly/tools").LSPClientLike
  /**
   * Additional tools to register beyond the standard set.
   * Use this for MCP tools, custom user tools, and plugins.
   */
  extraTools?: import("@butterfly/tools").Tool[]
  /**
   * Extra dispose callbacks called in order when dispose() is invoked.
   * Use for cleanup of LSP clients, MCP connections, plugin deactivation, etc.
   */
  extraDisposers?: Array<() => void | Promise<void>>
}

export interface AgentFactoryResult {
  loop: AgentLoop
  registry: ToolRegistry
  router: ModelRouter
  tokenizer: GPTTokenizer
  config: ButterflyConfig
  /** Clean up resources (shell, etc.). */
  dispose: () => Promise<void>
  /** Mutable file changes reference for rollback. */
  fileChangesRef: { changes: FileChange[] }
  /** Bootstrap summary for system prompt. */
  bootstrapSummary: string
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export async function createAgent(opts: AgentFactoryOptions): Promise<AgentFactoryResult> {
  const registry = new ToolRegistryClass()

  // Mutable session ID ref for session-scoped tools (todowrite, etc.).
  // The loop sets this when it starts running so tools can reference
  // the active session without the ToolContext carrying sessionId.
  const sessionRef = { current: "" }

  // Mutable todo list ref — the todowrite tool reads/writes this ref;
  // the loop syncs it into session.todos before each save so todos are
  // persisted alongside the session (survives restarts).
  const todosRef: { current: TodoItem[] } = { current: [] }

  // Register essential base tools (minimal set, OpenCode-inspired)
  registry.register(readTool)
  registry.register(writeTool)
  registry.register(patchTool)
  registry.register(diffPatchTool)
  registry.register(applyPatchTool)
  registry.register(deleteTool)
  registry.register(bashTool)
  registry.register(grepTool)
  registry.register(globTool)
  registry.register(listTool)
  registry.register(questionTool)
  registry.register(webFetchTool)
  registry.register(webSearchTool)
  registry.register(createLspTool((opts.lspClient ?? new NoOpLSPClient()) as LSPClientLike))

  // Session-scoped todowrite tool — persists todos per session via the mutable ref.
  // The loop syncs todosRef.current → session.todos before each save so todos
  // survive restarts and are shared across server instances.
  registry.register(
    createTodowriteTool({
      getTodos: () => todosRef.current,
      updateTodos: (todos: TodoItem[]) => {
        todosRef.current = todos
      },
    }),
  )

  // Plan exit tool — signals plan completion and asks user to switch to build mode.
  registry.register(planExitTool)

  // Register skill tool (needs cwd for skill discovery)
  registry.register(createSkillTool(opts.cwd))

  // Register caller-provided extra tools (LSP, MCP, custom, plugins, etc.)
  if (opts.extraTools) {
    for (const tool of opts.extraTools) {
      registry.register(tool)
    }
  }

  // Tiered model router.
  // Fallback chain: user tier config → DEFAULT_CONFIG tiers → config.model → empty string.
  // This makes Butterfly provider-agnostic: users only need to set `model`
  // (e.g., "openai/gpt-4o") and all tiers inherit it, rather than needing to
  // override every tier individually when switching providers.
  const tiers = opts.config.butterfly?.tiers ?? DEFAULT_CONFIG.butterfly?.tiers ?? {}
  const defaultModel = opts.config.model ?? DEFAULT_CONFIG.model ?? ""
  const router = new ModelRouter({
    tierMapping: {
      trivial: tiers.trivial || DEFAULT_CONFIG.butterfly?.tiers?.trivial || defaultModel,
      standard: tiers.standard || DEFAULT_CONFIG.butterfly?.tiers?.standard || defaultModel,
      complex: tiers.complex || DEFAULT_CONFIG.butterfly?.tiers?.complex || defaultModel,
      escalate: tiers.escalate || DEFAULT_CONFIG.butterfly?.tiers?.escalate || defaultModel,
    },
  })

  // File changes reference for rollback
  const fileChangesRef = { changes: [] as FileChange[] }

  // Rollback tool
  registry.register(
    createRollbackTool({
      getFileChanges: () => fileChangesRef.changes,
      cwd: opts.cwd,
    }),
  )

  // Quality monitor
  const qualityMonitor = new QualityMonitor()

  // Permission hook: caller-provided takes precedence, otherwise build from config.
  const permissionHook =
    opts.permissionHook ?? buildPermissionHook(opts.config.permission, opts.onAskUser)

  // Agent loop
  const sce = new SCE(opts.tokenizer)
  const loop = new AgentLoop({
    llm: opts.llm,
    providerService: opts.providerService,
    sce,
    coe: new COE(opts.tokenizer),
    router,
    registry,
    store: opts.store,
    parser: new ForgivingToolCallParser(),
    permissionHook,
    qualityMonitor,
    onStreamEvent: opts.onStreamEvent,
    bus: opts.bus,
    todosRef,
    onIteration: (session, iteration) => {
      // Keep session ref current for session-scoped tools (todowrite).
      sessionRef.current = session.id
      fileChangesRef.changes = session.fileChanges

      // Restore persisted todos from session into the mutable ref.
      // On the first iteration, session.todos carries the persisted state.
      if (session.todos && todosRef.current.length === 0) {
        todosRef.current = session.todos
      }

      // Git snapshot tracking (fire-and-forget, matches OpenCode's async snapshot pattern).
      // Snapshot after each iteration so the session has a revert point for every step.
      const snapshotService = getSnapshotService()
      snapshotService
        .track(opts.cwd)
        .then((hash) => {
          if (hash) {
            if (!session.snapshots) session.snapshots = {}
            session.snapshots[iteration] = hash
          }
        })
        .catch(() => {
          // Snapshot failure is non-fatal — the loop continues without a revert point.
        })

      opts.onIteration?.(session, iteration)
    },
    onAskUser: opts.onAskUser,
  })

  // Wrap run() to set the session ID before the first tool execution.
  // onIteration fires AFTER tool calls, so without this wrapper the first
  // iteration's tool calls (e.g., todowrite) see an empty session ID.
  const rawRun = loop.run.bind(loop)
  loop.run = async (req) => {
    sessionRef.current = req.session.id
    return rawRun(req)
  }

  // Semantic search tool (wraps SCE for model-callable code search)
  registry.register(createSearchTool({ sce, cwd: opts.cwd }))

  // Subagent
  const subagent = new Subagent(loop)
  registry.register(
    createSubagentTool({
      spawn: (task, cwd, mode, maxSteps) =>
        subagent.spawn({ task, cwd, mode: mode as "plan" | "build", maxSteps }),
    }),
  )

  // Bootstrap
  const bootstrap = detectProject(opts.cwd)

  // Skill discovery — preloads for the skill tool.
  // The discovered skills are available via the "skill" tool at runtime.
  // Skill list is also appended to the bootstrap summary so the model
  // knows which skills are available before making tool calls.
  const skillsPromptBlock = formatSkillsForPrompt(discoverSkills(opts.cwd))
  const bootstrapSummary = [bootstrap.summary, skillsPromptBlock].filter(Boolean).join("\n\n")

  // Activate plugins from config (post-registry setup, so plugins can use all tools).
  // Await activation so plugins are guaranteed loaded before the agent runs.
  const plugins = opts.config.plugin
  if (plugins && plugins.length > 0) {
    try {
      await activateAllPlugins(plugins, opts.cwd, registry)
    } catch (err) {
      log("error", `[factory] Plugin activation failed: ${(err as Error).message}`)
    }
  }

  // Background jobs: session cleanup, MCP heartbeats, stale lock cleanup.
  const backgroundJobs = startBackgroundJobs({
    cwd: opts.cwd,
    store: opts.store,
    config: opts.config as {
      butterfly?: { backgroundJobs?: { intervalMs?: number; staleSessionAgeMs?: number } }
    },
  })

  return {
    loop,
    registry,
    router,
    tokenizer: opts.tokenizer,
    config: opts.config,
    dispose: async () => {
      // Stop background jobs first.
      backgroundJobs.stop()
      // Deactivate plugins, then caller-provided disposers.
      try {
        await deactivateAllPlugins()
      } catch (err) {
        log("warn", `[factory] Plugin deactivation error: ${(err as Error).message}`)
      }
      if (opts.extraDisposers) {
        for (const d of opts.extraDisposers) {
          await d()
        }
      }
      // Clean up session todo state if a session ran.
      if (sessionRef.current) {
        todosRef.current = []
      }
    },
    fileChangesRef,
    bootstrapSummary,
  }
}
