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
import { ForgivingToolCallParser, type LLMClient, type LLMStreamEvent } from "@butterfly/llm"
import type { FileChange, SessionState, SessionStore } from "@butterfly/session"
import {
  activateAllPlugins,
  bashTool,
  createRollbackTool,
  createSearchTool,
  createSubagentTool,
  deactivateAllPlugins,
  deleteTool,
  diffPatchTool,
  globTool,
  grepTool,
  listTool,
  patchTool,
  questionTool,
  readTool,
  type ToolRegistry,
  ToolRegistry as ToolRegistryClass,
  writeTool,
} from "@butterfly/tools"
import { AgentLoop } from "./loop"
import { buildPermissionHook } from "./permission"
import { QualityMonitor } from "./quality-monitor"
import { ModelRouter } from "./router"
import { Subagent } from "./subagent"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentFactoryOptions {
  /** Working directory for the agent. */
  cwd: string
  /** LLM client instance (already created by the caller based on provider preferences). */
  llm: LLMClient
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
   * Additional tools to register beyond the standard set.
   * Use this for LSP tools, MCP tools, custom user tools, and plugins.
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

  // Register essential base tools (minimal set, OpenCode-inspired)
  registry.register(readTool)
  registry.register(writeTool)
  registry.register(patchTool)
  registry.register(diffPatchTool)
  registry.register(deleteTool)
  registry.register(bashTool)
  registry.register(grepTool)
  registry.register(globTool)
  registry.register(listTool)
  registry.register(questionTool)

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
    sce,
    coe: new COE(opts.tokenizer),
    router,
    registry,
    store: opts.store,
    parser: new ForgivingToolCallParser(),
    permissionHook,
    qualityMonitor,
    onStreamEvent: opts.onStreamEvent,
    onIteration: (session, iteration) => {
      fileChangesRef.changes = session.fileChanges
      opts.onIteration?.(session, iteration)
    },
    onAskUser: opts.onAskUser,
  })

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

  return {
    loop,
    registry,
    router,
    tokenizer: opts.tokenizer,
    config: opts.config,
    dispose: async () => {
      // Deactivate plugins first, then caller-provided disposers.
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
    },
    fileChangesRef,
    bootstrapSummary: bootstrap.summary || "",
  }
}
