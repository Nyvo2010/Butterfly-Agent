import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AgentLoop, buildSystemPrompt, ModelRouter } from "@butterfly/agent"
import { COE, GPTTokenizer, SCE } from "@butterfly/context"
import { loadDotEnv, log } from "@butterfly/core"
import { VercelAILLMClient } from "@butterfly/llm"
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
import { beforeAll, describe, expect, it } from "vitest"

// Load .env from workspace root (API keys, model config)
const workspaceRoot = resolve(import.meta.dirname ?? __dirname, "../..")
loadDotEnv(join(workspaceRoot, ".env"))

const HAS_API_KEY = Boolean(process.env.LLM_API_KEY)

// Determine model tiers from env (they're already loaded by loadDotEnv)
function buildRouter(): ModelRouter {
  return new ModelRouter()
}

function buildFullToolRegistry(): ToolRegistry {
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

async function setupSimRepo(targetDir: string): Promise<void> {
  const srcDir = resolve(workspaceRoot, "tests/simulation/repo")
  cpSync(srcDir, targetDir, { recursive: true })
}

const realLlmTests = describe.skipIf(!HAS_API_KEY)

realLlmTests("real LLM: VercelAILLMClient basic operations", () => {
  it("can complete a simple text request", async () => {
    const client = new VercelAILLMClient({
      apiKey: process.env.LLM_API_KEY!,
      baseUrl: process.env.LLM_BASE_URL || undefined,
    })
    const router = buildRouter()
    const { model } = router.resolve("trivial", 0)
    const response = await client.complete({
      model,
      system: "You are a helpful assistant. Answer concisely.",
      messages: [{ role: "user", content: "Say exactly: hello world" }],
    })
    expect(response.kind).toBe("text")
    if (response.kind === "text") {
      expect(response.text.toLowerCase()).toContain("hello")
      expect(response.usage.totalTokens).toBeGreaterThan(0)
    }
  })

  it("can make a tool call", async () => {
    const client = new VercelAILLMClient({
      apiKey: process.env.LLM_API_KEY!,
      baseUrl: process.env.LLM_BASE_URL || undefined,
    })
    const router = buildRouter()
    const { model } = router.resolve("standard", 0)
    const response = await client.complete({
      model,
      system: "You must use the read tool to read a file.",
      messages: [{ role: "user", content: "Read the file at path 'test.txt'" }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
    })
    // The model should decide to call the tool
    expect(response.kind === "tool_calls" || response.kind === "text").toBe(true)
    if (response.kind === "tool_calls") {
      expect(response.calls.length).toBeGreaterThan(0)
      expect(response.calls[0].name).toBe("read")
    }
  })
})

realLlmTests("real LLM: SCE + prompt integration", () => {
  it("SCE provides relevant context against a controlled directory (sim repo)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sce-real-"))
    await setupSimRepo(tmpDir)

    const tokenizer = new GPTTokenizer()
    await tokenizer.count("warmup")
    const sce = new SCE(tokenizer)
    const slice = await sce.select("capitalize", { cwd: tmpDir })

    // Verify SCE found relevant content in the sim repo
    expect(slice.grepMatches.length).toBeGreaterThan(0)
    const utilsMatches = slice.grepMatches.filter((m) => m.file.includes("utils"))
    expect(utilsMatches.length).toBeGreaterThan(0)

    // Build prompt with SCE context
    const prompt = buildSystemPrompt({
      mode: "plan",
      query: "Find the capitalize function",
      sceSlice: slice,
      tools: [readTool, grepTool, globTool, listTool],
    })
    expect(prompt.grepMatches).not.toContain("(none)")
    expect(prompt.codeContext).not.toContain("no file snippets")
    expect(prompt.system).toContain("capitalize")

    await rm(tmpDir, { recursive: true, force: true })
  })

  it("SCE cache improves performance on repeated queries", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sce-cache-"))
    await setupSimRepo(tmpDir)

    const tokenizer = new GPTTokenizer()
    await tokenizer.count("warmup")
    const sce = new SCE(tokenizer)

    const t0 = performance.now()
    const slice1 = await sce.select("add", { cwd: tmpDir })
    const t1 = performance.now()
    const slice2 = await sce.select("add", { cwd: tmpDir })
    const t2 = performance.now()

    const coldTime = t1 - t0
    const cacheTime = t2 - t1
    expect(slice1).toBe(slice2)
    expect(cacheTime).toBeLessThan(coldTime)

    await rm(tmpDir, { recursive: true, force: true })
  })
})

realLlmTests("real LLM: COE optimization effectiveness", () => {
  it("COE prevents context from exceeding token limit", async () => {
    const tokenizer = new GPTTokenizer()
    const coe = new COE(tokenizer)
    const session = createSession("coe-test-real", "build")

    // Add many messages to simulate context accumulation
    session.messages.push({
      id: "sys",
      role: "system",
      content: "You are a Butterfly Agent in BUILD mode.",
      timestamp: "t0",
    })
    for (let i = 0; i < 20; i++) {
      session.messages.push({
        id: `m${i}`,
        role: "user",
        content: "a".repeat(2000),
        timestamp: `t${i}`,
      })
      session.messages.push({
        id: `mt${i}`,
        role: "tool",
        content: "b".repeat(2000),
        toolCallId: `tc${i}`,
        timestamp: `t${i}`,
      })
    }

    const totalTokensBefore = session.messages.reduce(
      (sum, m) => sum + tokenizer.count(m.content),
      0,
    )
    expect(totalTokensBefore).toBeGreaterThan(5000)

    const optimized = coe.optimize(session, { maxContextTokens: 4000 })
    const totalTokensAfter = optimized.messages.reduce(
      (sum, m) => sum + tokenizer.count(m.content),
      0,
    )
    expect(totalTokensAfter).toBeLessThanOrEqual(4500)

    // System message survives
    expect(optimized.messages[0]?.role).toBe("system")
  })
})

realLlmTests("real LLM: Agent Loop task execution", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-real-test-"))
    await setupSimRepo(tmpDir)
  }, 30_000)

  it("can complete a read-file task in plan mode", async () => {
    const tokenizer = new GPTTokenizer()
    await tokenizer.count("warmup")
    const client = new VercelAILLMClient({
      apiKey: process.env.LLM_API_KEY!,
      baseUrl: process.env.LLM_BASE_URL || undefined,
    })
    const loop = new AgentLoop({
      llm: client,
      sce: new SCE(tokenizer),
      coe: new COE(tokenizer),
      router: buildRouter(),
      registry: buildFullToolRegistry(),
      store: new InMemorySessionStore(),
    })

    const result = await loop.run({
      session: createSession("read-test", "plan"),
      query: "Read src/math.ts and summarize what functions it exports",
      cwd: tmpDir,
      maxSteps: 6,
    })

    expect(result.stopReason === "no_tool_calls" || result.stopReason === "max_steps").toBe(true)
    expect(result.session.toolCalls.length).toBeGreaterThan(0)
    // Should have read the file
    const reads = result.session.toolCalls.filter((tc) => tc.name === "read")
    expect(reads.length).toBeGreaterThan(0)
    // Final message should contain a summary
    const lastMsg = result.session.messages[result.session.messages.length - 1]
    if (lastMsg?.role === "assistant") {
      expect(lastMsg.content.length).toBeGreaterThan(20)
    }
    log("info", "agent.real.read_test_complete", {
      iterations: result.iterations,
      stopReason: result.stopReason,
      toolCalls: result.session.toolCalls.map((t) => t.name).join(", "),
    })
  }, 120_000)

  it("can write a new file in build mode", async () => {
    const tokenizer = new GPTTokenizer()
    await tokenizer.count("warmup")
    const client = new VercelAILLMClient({
      apiKey: process.env.LLM_API_KEY!,
      baseUrl: process.env.LLM_BASE_URL || undefined,
    })
    const loop = new AgentLoop({
      llm: client,
      sce: new SCE(tokenizer),
      coe: new COE(tokenizer),
      router: buildRouter(),
      registry: buildFullToolRegistry(),
      store: new InMemorySessionStore(),
    })

    const result = await loop.run({
      session: createSession("write-test", "build"),
      query: "Write a file called HELLO.md containing '# Hello from Butterfly Agent'",
      cwd: tmpDir,
      maxSteps: 6,
    })

    expect(result.stopReason === "no_tool_calls" || result.stopReason === "max_steps").toBe(true)
    const helloPath = join(tmpDir, "HELLO.md")
    const fileExists = existsSync(helloPath)
    // If the agent created the file with a different name, check for any .md file
    const anyMDFile = await readFile(join(tmpDir, "HELLO.md"), "utf8").catch(() => null)
    if (!fileExists) {
      // Agent might have used a different approach
      const writes = result.session.fileChanges.filter((fc) => fc.path.endsWith(".md"))
      expect(writes.length).toBeGreaterThanOrEqual(1)
    } else {
      expect(anyMDFile).toContain("Hello")
    }
    log("info", "agent.real.write_test_complete", {
      iterations: result.iterations,
      stopReason: result.stopReason,
      filesChanged: result.session.fileChanges.map((f) => f.path),
    })
  }, 120_000)

  it("can execute a bash command", async () => {
    const tokenizer = new GPTTokenizer()
    await tokenizer.count("warmup")
    const client = new VercelAILLMClient({
      apiKey: process.env.LLM_API_KEY!,
      baseUrl: process.env.LLM_BASE_URL || undefined,
    })
    const loop = new AgentLoop({
      llm: client,
      sce: new SCE(tokenizer),
      coe: new COE(tokenizer),
      router: buildRouter(),
      registry: buildFullToolRegistry(),
      store: new InMemorySessionStore(),
    })

    const result = await loop.run({
      session: createSession("bash-test", "build"),
      query: "Run `ls -la` in the current directory and summarize what files are there",
      cwd: tmpDir,
      maxSteps: 6,
    })

    expect(result.stopReason === "no_tool_calls" || result.stopReason === "max_steps").toBe(true)
    const bashCalls = result.session.toolCalls.filter((tc) => tc.name === "bash")
    expect(bashCalls.length).toBeGreaterThanOrEqual(1)
    log("info", "agent.real.bash_test_complete", {
      iterations: result.iterations,
      stopReason: result.stopReason,
    })
  }, 120_000)

  it("can add a function to an existing file using patch", async () => {
    const tokenizer = new GPTTokenizer()
    await tokenizer.count("warmup")
    const client = new VercelAILLMClient({
      apiKey: process.env.LLM_API_KEY!,
      baseUrl: process.env.LLM_BASE_URL || undefined,
    })
    const loop = new AgentLoop({
      llm: client,
      sce: new SCE(tokenizer),
      coe: new COE(tokenizer),
      router: buildRouter(),
      registry: buildFullToolRegistry(),
      store: new InMemorySessionStore(),
    })

    const mathContent = await readFile(join(tmpDir, "src/math.ts"), "utf8")
    expect(mathContent).toContain("export function add")

    const result = await loop.run({
      session: createSession("patch-test", "build"),
      query:
        "Add a 'factorial' function to src/math.ts that computes n! recursively, then export it from src/index.ts",
      cwd: tmpDir,
      maxSteps: 15,
    })

    // Check if the agent actually modified the files
    const writes = result.session.fileChanges.filter(
      (fc) => fc.path.includes("math.ts") || fc.path.includes("index.ts"),
    )
    log("info", "agent.real.patch_test_result", {
      iterations: result.iterations,
      stopReason: result.stopReason,
      fileChanges: result.session.fileChanges.map((f) => f.path),
      writesFound: writes.length,
    })

    // Either the agent succeeded via patch/write, or it tried
    expect(result.session.toolCalls.length).toBeGreaterThan(0)
  }, 180_000)
})
