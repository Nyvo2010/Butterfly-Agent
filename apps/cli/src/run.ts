import type { PermissionHook } from "@butterfly/agent"
import { AgentLoop, ModelRouter, Subagent } from "@butterfly/agent"
import { COE, GPTTokenizer, SCE, StdioLSPClient } from "@butterfly/context"
import { loadConfig, log, loadButterflyConfig, getUserInstructions } from "@butterfly/core"
import { ForgivingToolCallParser, VercelAILLMClient } from "@butterfly/llm"
import { createSession, FileSystemSessionStore } from "@butterfly/session"
import {
  activateAllPlugins,
  backgroundBashTool,
  backgroundKillTool,
  backgroundStatusTool,
  bashTool,
  connectAllMCPServers,
  createLSPDiagnosticsTool,
  createLSPGoToDefinitionTool,
  createLSPReferencesTool,
  createRollbackTool,
  createSubagentTool,
  deactivateAllPlugins,
  deleteTool,
  diffPatchTool,
  disconnectAllMCPServers,
  globTool,
  grepTool,
  listTool,
  patchTool,
  readTool,
  ToolRegistry,
  writeTool,
} from "@butterfly/tools"
import { createInterface } from "node:readline"

export interface RunOptions {
  task: string
  cwd: string
  maxSteps?: number
  resumeSessionId?: string
}

/**
 * Interactive permission hook using readline.
 * Prompts the user for y/n on destructive tool calls.
 */
function createPermissionHook(): PermissionHook {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return async (toolName, input) => {
    const desc = JSON.stringify(input).slice(0, 200)
    const answer = await new Promise<string>((resolve) => {
      rl.question(`[butterfly] Allow ${toolName} ${desc}? (y/n) `, resolve)
    })
    if (answer.toLowerCase().startsWith("y")) {
      return { allowed: true }
    }
    return { allowed: false, reason: "User denied permission." }
  }
}

export async function runAgent(opts: RunOptions) {
  const cfg = loadConfig()
  if (!cfg.llm.apiKey) {
    throw new Error(
      "LLM_API_KEY is required. Set it in .env or as an environment variable.",
    )
  }

  const bfConfig = loadButterflyConfig(opts.cwd)
  const userInstructions = getUserInstructions(bfConfig)

  log("info", "cli.run.start", {
    cwd: opts.cwd,
    task: opts.task.slice(0, 200),
    model: cfg.llm.baseUrl || "default",
    resumeSessionId: opts.resumeSessionId,
    hasConfig: Boolean(bfConfig.instructions?.length),
    hasMCP: Boolean(bfConfig.mcp && Object.keys(bfConfig.mcp).length > 0),
    hasPlugins: Boolean(bfConfig.plugin && bfConfig.plugin.length > 0),
  })

  const tokenizer = new GPTTokenizer()
  await tokenizer.count("warmup")

  const registry = new ToolRegistry()
  registry.register(readTool)
  registry.register(writeTool)
  registry.register(patchTool)
  registry.register(diffPatchTool)
  registry.register(deleteTool)
  registry.register(bashTool)
  registry.register(backgroundBashTool)
  registry.register(backgroundStatusTool)
  registry.register(backgroundKillTool)
  registry.register(grepTool)
  registry.register(globTool)
  registry.register(listTool)

  // LSP client: connect to language server for code intelligence.
  const lsp = new StdioLSPClient(opts.cwd)
  try {
    // Lazy-init: don't block startup on LSP connection.
    registry.register(createLSPGoToDefinitionTool(lsp))
    registry.register(createLSPDiagnosticsTool(lsp))
    registry.register(createLSPReferencesTool(lsp))
    log("info", "cli.run.lsp_registered")
  } catch (err) {
    log("warn", "cli.run.lsp_unavailable", { error: (err as Error).message })
  }

  // Activate plugins from config
  if (bfConfig.plugin && bfConfig.plugin.length > 0) {
    await activateAllPlugins(bfConfig.plugin, opts.cwd, registry)
  }

  // Connect to MCP servers from config
  if (bfConfig.mcp && Object.keys(bfConfig.mcp).length > 0) {
    try {
      const mcpTools = await connectAllMCPServers(bfConfig.mcp)
      for (const tool of mcpTools) {
        registry.register(tool)
      }
      log("info", "cli.run.mcp_connected", { toolCount: mcpTools.length })
    } catch (err) {
      log("error", "cli.run.mcp_error", { error: (err as Error).message })
    }
  }

  const llm = new VercelAILLMClient({
    apiKey: cfg.llm.apiKey,
    baseUrl: cfg.llm.baseUrl || undefined,
  })

  const store = new FileSystemSessionStore()

  const tiers = bfConfig.butterfly?.tiers
  const router = new ModelRouter({
    tierMapping: {
      trivial: tiers?.trivial ?? "anthropic:claude-haiku-4-5",
      standard: tiers?.standard ?? "anthropic:claude-sonnet-4-5",
      complex: tiers?.complex ?? "anthropic:claude-sonnet-4-5",
      escalate: tiers?.escalate ?? "anthropic:claude-opus-4-1",
    },
  })

  // Mutable reference updated after each iteration so rollback works mid-loop.
  const fileChangesRef = { changes: [] as import("@butterfly/session").FileChange[] }

  // Permission hook: ask before destructive tools.
  const permissionHook = createPermissionHook()

  // Streaming: print text deltas to terminal in real time.
  const onStreamEvent = (event: { kind: string; text?: string }) => {
    if (event.kind === "text_delta" && event.text) {
      process.stderr.write(event.text)
    }
  }

  const loop = new AgentLoop({
    llm,
    sce: new SCE(tokenizer),
    coe: new COE(tokenizer),
    router,
    registry,
    store,
    parser: new ForgivingToolCallParser(),
    permissionHook,
    onStreamEvent,
    // Update rollback reference after each iteration for mid-loop visibility.
    onIteration: (session) => {
      fileChangesRef.changes = session.fileChanges
    },
  })

  const subagent = new Subagent(loop)
  const subagentTool = createSubagentTool({
    spawn: (task, cwd, mode, maxSteps) =>
      subagent.spawn({ task, cwd, mode: mode as "plan" | "build", maxSteps }),
  })
  registry.register(subagentTool)

  const rollbackTool = createRollbackTool({
    getFileChanges: () => fileChangesRef.changes,
    cwd: opts.cwd,
  })
  registry.register(rollbackTool)

  let session = createSession("cli-session", "build")
  if (opts.resumeSessionId) {
    const existing = await store.load(opts.resumeSessionId)
    if (existing) {
      session = existing
      log("info", "cli.run.resume", {
        sessionId: existing.id,
        messageCount: existing.messages.length,
      })
    }
  }

  let query = opts.task
  if (userInstructions) {
    query = `${userInstructions}\n\n---\n${opts.task}`
  }

  const sceOptions = bfConfig.butterfly?.sce
  const maxSteps = opts.maxSteps ?? bfConfig.butterfly?.maxSteps ?? 20

  const result = await loop.run({
    session,
    query,
    cwd: opts.cwd,
    maxSteps,
    sceOptions: sceOptions
      ? {
          maxFiles: sceOptions.maxFiles,
          maxTokensPerFile: sceOptions.maxTokensPerFile,
          maxGrepResults: sceOptions.maxGrepResults,
          topFiles: sceOptions.topFiles,
        }
      : undefined,
  })

  // Graceful shutdown.
  await lsp.shutdown().catch(() => {})
  await disconnectAllMCPServers()
  await deactivateAllPlugins()

  log("info", "cli.run.done", {
    iterations: result.iterations,
    stopReason: result.stopReason,
    filesChanged: result.session.fileChanges.map((f) => f.path),
  })
  return result
}
