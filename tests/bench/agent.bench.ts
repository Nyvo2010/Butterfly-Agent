import { join } from "node:path"
import { AgentLoop, buildSystemPrompt, ModelRouter, Subagent } from "@butterfly/agent"
import { COE, GPTTokenizer, SCE } from "@butterfly/context"
import { MockLLMClient, textResponse, toolCallResponse } from "@butterfly/llm"
import { createSession, InMemorySessionStore } from "@butterfly/session"
import { bashTool, readTool, ToolRegistry, writeTool } from "@butterfly/tools"
import { bench, describe } from "vitest"

describe("AgentLoop bench", () => {
  const tok = new GPTTokenizer()
  const sce = new SCE(tok)
  const coe = new COE(tok)
  const router = new ModelRouter()
  const registry = new ToolRegistry()
  registry.register(readTool)
  registry.register(writeTool)
  registry.register(bashTool)

  bench("single text-response iteration", async () => {
    const llm = new MockLLMClient([textResponse("done")])
    const store = new InMemorySessionStore()
    const loop = new AgentLoop({ llm, sce, coe, router, registry, store })
    await loop.run({
      session: createSession("b1", "build"),
      query: "test",
      cwd: "/tmp",
    })
  })

  bench("single tool-call iteration (list)", async () => {
    const { listTool } = await import("@butterfly/tools")
    const reg = new ToolRegistry()
    reg.register(listTool)
    reg.register(readTool)
    reg.register(bashTool)
    const llm = new MockLLMClient([
      toolCallResponse([{ id: "c1", name: "list", input: { path: "." } }]),
      textResponse("done"),
    ])
    const store = new InMemorySessionStore()
    const loop = new AgentLoop({ llm, sce, coe, router, registry: reg, store })
    await loop.run({
      session: createSession("b2", "build"),
      query: "list",
      cwd: "/tmp",
    })
  })

  bench("buildSystemPrompt with 7 tools", () => {
    buildSystemPrompt({
      mode: "build",
      query: "do something complex that requires many tools and context",
      sceSlice: {
        grepMatches: [
          { file: "src/a.ts", line: 1, content: "export function foo" },
          { file: "src/b.ts", line: 5, content: "export const bar" },
        ],
        fileSnippets: [
          { path: "src/a.ts", content: "export function foo() { return 1 }", tokens: 10 },
          { path: "src/b.ts", content: "export const bar = 2", tokens: 8 },
        ],
      },
      tools: [readTool, writeTool, bashTool],
    })
  })
})

describe("Subagent bench", () => {
  const tok = new GPTTokenizer()
  const sce = new SCE(tok)
  const coe = new COE(tok)
  const router = new ModelRouter()
  const registry = new ToolRegistry()
  registry.register(readTool)
  registry.register(writeTool)

  bench("spawn with text response", async () => {
    const llm = new MockLLMClient([textResponse("done")])
    const store = new InMemorySessionStore()
    const loop = new AgentLoop({ llm, sce, coe, router, registry, store })
    const sub = new Subagent(loop)
    await sub.spawn({ task: "do something", cwd: "/tmp" })
  })
})
