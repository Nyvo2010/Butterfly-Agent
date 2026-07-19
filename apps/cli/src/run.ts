import { AgentLoop, ModelRouter, Subagent } from "@butterfly/agent"
import { COE, GPTTokenizer, SCE } from "@butterfly/context"
import { loadConfig, log } from "@butterfly/core"
import { ForgivingToolCallParser, VercelAILLMClient } from "@butterfly/llm"
import { createSession, FileSystemSessionStore } from "@butterfly/session"
import {
  bashTool,
  createSubagentTool,
  deleteTool,
  globTool,
  grepTool,
  listTool,
  patchTool,
  readTool,
  ToolRegistry,
  writeTool,
} from "@butterfly/tools"

export interface RunOptions {
  task: string
  cwd: string
  /** Cap loop iterations (default 20). */
  maxSteps?: number
}

export async function runAgent(opts: RunOptions) {
  const cfg = loadConfig()
  if (!cfg.llm.apiKey) {
    throw new Error(
      "LLM_API_KEY is required. Set it in .env or as an environment variable.",
    )
  }

  log("info", "cli.run.start", {
    cwd: opts.cwd,
    task: opts.task.slice(0, 200),
    model: cfg.llm.baseUrl || "default",
  })

  const tokenizer = new GPTTokenizer()
  await tokenizer.count("warmup")

  const registry = new ToolRegistry()
  registry.register(readTool)
  registry.register(writeTool)
  registry.register(patchTool)
  registry.register(deleteTool)
  registry.register(bashTool)
  registry.register(grepTool)
  registry.register(globTool)
  registry.register(listTool)

  const llm = new VercelAILLMClient({
    apiKey: cfg.llm.apiKey,
    baseUrl: cfg.llm.baseUrl || undefined,
  })

  const store = new FileSystemSessionStore(opts.cwd)
  const loop = new AgentLoop({
    llm,
    sce: new SCE(tokenizer),
    coe: new COE(tokenizer),
    router: new ModelRouter(),
    registry,
    store,
    parser: new ForgivingToolCallParser(),
  })

  // Wire the subagent tool AFTER constructing the loop, then register it.
  // This avoids a circular dependency: tools → agent → tools.
  const subagent = new Subagent(loop)
  const subagentTool = createSubagentTool({
    spawn: (task, cwd, mode, maxSteps) =>
      subagent.spawn({ task, cwd, mode: mode as "plan" | "build", maxSteps }),
  })
  registry.register(subagentTool)

  const session = createSession("cli-session", "build")
  const result = await loop.run({
    session,
    query: opts.task,
    cwd: opts.cwd,
    maxSteps: opts.maxSteps ?? 20,
  })
  log("info", "cli.run.done", {
    iterations: result.iterations,
    stopReason: result.stopReason,
    filesChanged: result.session.fileChanges.map((f) => f.path),
  })
  return result
}
