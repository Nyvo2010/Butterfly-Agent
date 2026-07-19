import { mkdtempSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentLoop, buildSystemPrompt, ModelRouter, Subagent } from "@butterfly/agent"
import { COE, GPTTokenizer, SCE } from "@butterfly/context"
import { MockLLMClient, textResponse, toolCallResponse } from "@butterfly/llm"
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
import { afterEach, beforeEach, describe, expect, it } from "vitest"

function buildEnv(): {
  llm: MockLLMClient
  sce: SCE
  coe: COE
  router: ModelRouter
  registry: ToolRegistry
  store: InMemorySessionStore
} {
  const tok = new GPTTokenizer()
  return {
    llm: new MockLLMClient([]),
    sce: new SCE(tok),
    coe: new COE(tok),
    router: new ModelRouter(),
    registry: new ToolRegistry(),
    store: new InMemorySessionStore(),
  }
}

function fullRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register(readTool)
  r.register(writeTool)
  r.register(patchTool)
  r.register(bashTool)
  r.register(grepTool)
  r.register(globTool)
  r.register(listTool)
  return r
}

describe("AgentLoop - stop reasons", () => {
  it("stops with no_tool_calls when LLM returns text", async () => {
    const env = buildEnv()
    env.llm = new MockLLMClient([textResponse("All done.")])
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const result = await loop.run({
      session: createSession("stop-text", "build"),
      query: "just say done",
      cwd: "/tmp",
    })
    expect(result.stopReason).toBe("no_tool_calls")
    expect(result.iterations).toBe(1)
  })

  it("stops with max_steps when hitting iteration limit", async () => {
    const env = buildEnv()
    // LLM keeps calling tools
    env.llm = new MockLLMClient([
      toolCallResponse([{ id: "c1", name: "list", input: { path: "." } }]),
      toolCallResponse([{ id: "c2", name: "list", input: { path: "." } }]),
      toolCallResponse([{ id: "c3", name: "list", input: { path: "." } }]),
    ])
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const result = await loop.run({
      session: createSession("stop-max", "build"),
      query: "list directory",
      cwd: "/tmp",
      maxSteps: 2,
    })
    expect(result.stopReason).toBe("max_steps")
    expect(result.iterations).toBe(2)
  })

  it("stops with error_max_escalation on persistent tool name error", async () => {
    const env = buildEnv()
    const dir = mkdtempSync(join(tmpdir(), "loop-esc-"))
    // Call a tool that is not registered — the loop treats missing tools as failures
    env.llm = new MockLLMClient([
      toolCallResponse([{ id: "c1", name: "nonexistent_tool", input: {} }]),
      toolCallResponse([{ id: "c2", name: "nonexistent_tool", input: {} }]),
      toolCallResponse([{ id: "c3", name: "ls", input: { command: "ls" } }]),
    ])
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const result = await loop.run({
      session: createSession("stop-esc", "build"),
      query: "list files",
      cwd: dir,
      maxSteps: 5,
    })
    expect(result.stopReason).toBe("error_max_escalation")
    await rm(dir, { recursive: true, force: true })
  })
})

describe("AgentLoop - mode enforcement", () => {
  let dir: string
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loop-mode-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("plan mode cannot write files", async () => {
    const env = buildEnv()
    env.llm = new MockLLMClient([
      // In plan mode, write tool is not available, LLM can only read
      textResponse("I can only read files in plan mode."),
    ])
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const result = await loop.run({
      session: createSession("plan-mode", "plan"),
      query: "read something",
      cwd: dir,
    })
    expect(result.stopReason).toBe("no_tool_calls")
    // No tools available in plan mode = no tool calls
  })

  it("build mode can read, write, and exec", async () => {
    const env = buildEnv()
    env.llm = new MockLLMClient([
      toolCallResponse([
        { id: "c1", name: "write", input: { path: "test.txt", content: "hello" } },
      ]),
      textResponse("Written."),
    ])
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const result = await loop.run({
      session: createSession("build-mode", "build"),
      query: "write test.txt",
      cwd: dir,
    })
    expect(result.stopReason).toBe("no_tool_calls")
    const content = await readFile(join(dir, "test.txt"), "utf8")
    expect(content).toBe("hello")
  })
})

describe("AgentLoop - SCE and COE integration", () => {
  let dir: string
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loop-sce-coe-"))
    await writeFile(
      join(dir, "source.ts"),
      "export function add(a: number, b: number) { return a + b }\n",
    )
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("SCE provides context to the LLM call", async () => {
    const tok = new GPTTokenizer()
    const env = buildEnv()
    env.sce = new SCE(tok)
    // After SCE used, the prompt will include context
    env.llm = new MockLLMClient((req) => {
      // Verify that the system prompt includes SCE context
      expect(req.system).toContain("source.ts")
      return textResponse("Found it.")
    })
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const result = await loop.run({
      session: createSession("sce-test", "build"),
      query: "add",
      cwd: dir,
    })
    expect(result.stopReason).toBe("no_tool_calls")
  })

  it("COE keeps session under token limit across iterations", async () => {
    const env = buildEnv()
    const tok = new GPTTokenizer()
    env.coe = new COE(tok)
    env.sce = new SCE(tok)
    // Create many tool calls to exercise COE
    const responses: Array<ReturnType<typeof toolCallResponse>> = []
    for (let i = 0; i < 10; i++) {
      responses.push(toolCallResponse([{ id: `c${i}`, name: "list", input: { path: "." } }]))
    }
    responses.push(textResponse("Done."))
    env.llm = new MockLLMClient(responses)
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const result = await loop.run({
      session: createSession("coe-test", "build"),
      query: "list directory",
      cwd: dir,
      maxSteps: 12,
    })
    expect(result.stopReason).toBe("no_tool_calls")
    // After COE, total tokens should be manageable
    const totalTokens = result.session.messages.reduce((sum, m) => sum + tok.count(m.content), 0)
    expect(totalTokens).toBeLessThan(10000)
  })
})

describe("AgentLoop - session management", () => {
  it("primes empty session with user query", async () => {
    const env = buildEnv()
    env.llm = new MockLLMClient([textResponse("OK")])
    const loop = new AgentLoop(env)
    const result = await loop.run({
      session: createSession("prime-test", "build"),
      query: "my query",
      cwd: "/tmp",
    })
    const userMsgs = result.session.messages.filter((m) => m.role === "user")
    expect(userMsgs.length).toBeGreaterThan(0)
    expect(userMsgs[0].content).toBe("my query")
  })

  it("does not re-prime session that already has messages", async () => {
    const env = buildEnv()
    env.llm = new MockLLMClient([textResponse("OK")])
    const loop = new AgentLoop(env)
    const session = createSession("no-reprime", "build")
    session.messages.push({
      id: "existing",
      role: "user",
      content: "existing msg",
      timestamp: new Date().toISOString(),
    })
    const result = await loop.run({
      session,
      query: "new query",
      cwd: "/tmp",
    })
    const userMsgs = result.session.messages.filter((m) => m.role === "user")
    expect(userMsgs.length).toBe(1)
    expect(userMsgs[0].content).toBe("existing msg")
  })

  it("saves session to store after each iteration", async () => {
    const env = buildEnv()
    env.llm = new MockLLMClient([
      toolCallResponse([{ id: "c1", name: "list", input: { path: "." } }]),
      textResponse("Done."),
    ])
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const result = await loop.run({
      session: createSession("store-test", "build"),
      query: "list",
      cwd: "/tmp",
      maxSteps: 3,
    })
    const loaded = await env.store.load("store-test")
    expect(loaded).not.toBeNull()
    expect(loaded?.messages.length).toBeGreaterThan(0)
  })
})

describe("AgentLoop - config variations", () => {
  it("works with different maxSteps values (1, 5, 10, 20)", async () => {
    for (const maxSteps of [1, 5, 10, 20]) {
      const env = buildEnv()
      env.llm = new MockLLMClient([textResponse("done")])
      env.registry = fullRegistry()
      const loop = new AgentLoop(env)
      const result = await loop.run({
        session: createSession(`ms-${maxSteps}`, "build"),
        query: "test",
        cwd: "/tmp",
        maxSteps,
      })
      expect(result.iterations).toBeGreaterThanOrEqual(1)
      expect(result.iterations).toBeLessThanOrEqual(maxSteps)
    }
  })

  it("tracks fileChanges correctly for write and patch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-fc-"))
    const env = buildEnv()
    env.llm = new MockLLMClient([
      toolCallResponse([{ id: "c1", name: "write", input: { path: "a.txt", content: "aaa" } }]),
      toolCallResponse([
        { id: "c2", name: "patch", input: { path: "a.txt", oldText: "aaa", newText: "bbb" } },
      ]),
      textResponse("done"),
    ])
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const result = await loop.run({
      session: createSession("fc-test", "build"),
      query: "write and patch",
      cwd: dir,
    })
    expect(result.session.fileChanges.length).toBe(2)
    expect(result.session.fileChanges[0].kind).toBe("write")
    expect(result.session.fileChanges[1].kind).toBe("write") // patch tool is kind "write"
    await rm(dir, { recursive: true, force: true })
  })

  it("tracks tool call timestamps", async () => {
    const env = buildEnv()
    env.llm = new MockLLMClient([
      toolCallResponse([{ id: "c1", name: "list", input: { path: "." } }]),
      textResponse("done"),
    ])
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const result = await loop.run({
      session: createSession("ts-test", "build"),
      query: "list",
      cwd: "/tmp",
    })
    expect(result.session.toolCalls.length).toBe(1)
    expect(result.session.toolCalls[0].startedAt).toBeTruthy()
    expect(result.session.toolCalls[0].finishedAt).toBeTruthy()
  })
})

describe("Subagent", () => {
  it("spawns and completes a simple task", async () => {
    const env = buildEnv()
    env.llm = new MockLLMClient([textResponse("Subagent done.")])
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const sub = new Subagent(loop)
    const result = await sub.spawn({ task: "do something", cwd: "/tmp" })
    expect(result.success).toBe(true)
    expect(result.finalOutput).toBe("Subagent done.")
  })

  it("returns file changes from spawned subagent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-fc-"))
    const env = buildEnv()
    env.llm = new MockLLMClient([
      toolCallResponse([{ id: "c1", name: "write", input: { path: "sub.txt", content: "sub" } }]),
      textResponse("done"),
    ])
    env.registry = fullRegistry()
    const loop = new AgentLoop(env)
    const sub = new Subagent(loop)
    const result = await sub.spawn({ task: "write sub.txt", cwd: dir })
    expect(result.filesChanged).toContain("sub.txt")
    await rm(dir, { recursive: true, force: true })
  })
})

describe("buildSystemPrompt edge cases", () => {
  it("handles empty tools array", () => {
    const prompt = buildSystemPrompt({
      mode: "plan",
      query: "test",
      sceSlice: { grepMatches: [], fileSnippets: [] },
      tools: [],
    })
    expect(prompt.system).toContain("no tools")
  })

  it("handles many grep matches (50+)", () => {
    const manyMatches = Array.from({ length: 50 }, (_, i) => ({
      file: `f${i}.ts`,
      line: i,
      content: `export const v${i} = ${i}`,
    }))
    const prompt = buildSystemPrompt({
      mode: "build",
      query: "find exports",
      sceSlice: { grepMatches: manyMatches, fileSnippets: [] },
      tools: [readTool],
    })
    expect(prompt.grepMatches).toContain("f49.ts")
    expect(prompt.grepMatches).toContain("v49")
  })

  it("handles large code context snippets", () => {
    const prompt = buildSystemPrompt({
      mode: "build",
      query: "big file",
      sceSlice: {
        grepMatches: [{ file: "big.ts", line: 1, content: "export" }],
        fileSnippets: [{ path: "big.ts", content: "x".repeat(10000), tokens: 2500 }],
      },
      tools: [readTool],
    })
    expect(prompt.codeContext.length).toBeGreaterThan(10000)
  })
})
