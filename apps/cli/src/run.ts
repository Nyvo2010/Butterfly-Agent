import { AgentLoop, ModelRouter } from "@butterfly/agent"
import { COE, GPTTokenizer, SCE } from "@butterfly/context"
import { loadConfig, log } from "@butterfly/core"
import { ForgivingToolCallParser, MockLLMClient, textResponse, toolCallResponse, VercelAILLMClient } from "@butterfly/llm"
import { createSession, InMemorySessionStore } from "@butterfly/session"
import {
  bashTool,
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
  /** Force MockLLM regardless of LLM_API_KEY env. */
  mockLLM?: boolean
  /** Custom scripted sequence for the MockLLM (overrides default). */
  script?: import("@butterfly/llm").LLMResponse[]
  /** Cap loop iterations (default 20). */
  maxSteps?: number
}

export interface RunOutput {
  result: Awaited<ReturnType<AgentLoop["run"]>>
  usedMock: boolean
}

export async function runAgent(opts: RunOptions): Promise<RunOutput> {
  const cfg = loadConfig()
  const hasKey = Boolean(cfg.llm.apiKey)
  const useMock = opts.mockLLM ?? !hasKey
  log("info", "cli.run.start", {
    cwd: opts.cwd,
    task: opts.task.slice(0, 200),
    usedMock: useMock,
    hasKey,
  })

  const tokenizer = new GPTTokenizer()
  await tokenizer.count("warmup")

  const registry = new ToolRegistry()
  registry.register(readTool)
  registry.register(writeTool)
  registry.register(patchTool)
  registry.register(bashTool)
  registry.register(grepTool)
  registry.register(globTool)
  registry.register(listTool)

  const llm = useMock
    ? new MockLLMClient(opts.script ?? defaultScript(opts.task, opts.cwd))
    : new VercelAILLMClient({ apiKey: cfg.llm.apiKey, baseUrl: cfg.llm.baseUrl || undefined })

  const store = new InMemorySessionStore()
  const loop = new AgentLoop({
    llm,
    sce: new SCE(tokenizer),
    coe: new COE(tokenizer),
    router: new ModelRouter(),
    registry,
    store,
    parser: new ForgivingToolCallParser(),
  })

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
  return { result, usedMock: useMock }
}

function defaultScript(task: string, _cwd: string): import("@butterfly/llm").LLMResponse[] {
  // Default safe script: glob anything → read the README → write a FINDINGS.md → text-end.
  const lower = task.toLowerCase()
  if (lower.includes("readme") || lower.includes("summary") || lower.includes("summarize")) {
    return [
      toolCallResponse([{ id: "c1", name: "glob", input: { pattern: "**/*.md" } }]),
      toolCallResponse([{ id: "c2", name: "read", input: { path: "README.md" } }]),
      toolCallResponse([
        {
          id: "c3",
          name: "write",
          input: { path: "FINDINGS.md", content: "## Summary\nDemo findings from CLI run." },
        },
      ]),
      textResponse("Done. See FINDINGS.md."),
    ]
  }
  return [
    toolCallResponse([{ id: "c1", name: "list", input: { path: "." } }]),
    toolCallResponse([{ id: "c2", name: "read", input: { path: "package.json" } }]),
    textResponse("Done."),
  ]
}
