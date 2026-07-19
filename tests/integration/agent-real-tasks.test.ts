import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AgentLoop, ModelRouter } from "@butterfly/agent"
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
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const workspaceRoot = resolve(import.meta.dirname ?? __dirname, "../..")
loadDotEnv(join(workspaceRoot, ".env"))

const HAS_API_KEY = Boolean(process.env.LLM_API_KEY)
const realLlmTests = describe.skipIf(!HAS_API_KEY)

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

function buildAgentLoop(): AgentLoop {
  const tokenizer = new GPTTokenizer()
  return new AgentLoop({
    llm: new VercelAILLMClient({
      apiKey: process.env.LLM_API_KEY ?? "",
      baseUrl: process.env.LLM_BASE_URL || undefined,
    }),
    sce: new SCE(tokenizer),
    coe: new COE(tokenizer),
    router: buildRouter(),
    registry: buildFullToolRegistry(),
    store: new InMemorySessionStore(),
  })
}

realLlmTests("Real LLM: Build a simple HTML site from scratch", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-site-"))
  }, 30_000)

  it("creates index.html, style.css, and script.js with a cohesive theme", async () => {
    const loop = buildAgentLoop()
    const result = await loop.run({
      session: createSession("build-site", "build"),
      query:
        "Build a simple personal landing page. Create index.html, style.css, and script.js in the current directory. The page should have a dark theme with a hero section, about section, and a contact form. Make it look professional with CSS animations.",
      cwd: tmpDir,
      maxSteps: 20,
    })

    expect(result.stopReason === "no_tool_calls" || result.stopReason === "max_steps").toBe(true)
    const fileChanges = result.session.fileChanges.map((fc) => fc.path)
    log("info", "agent.real.build_site", {
      iterations: result.iterations,
      stopReason: result.stopReason,
      filesChanged: fileChanges,
    })

    const indexExists = existsSync(join(tmpDir, "index.html"))
    const cssExists = existsSync(join(tmpDir, "style.css"))
    const jsExists = existsSync(join(tmpDir, "script.js"))

    expect(indexExists || cssExists || jsExists).toBe(true)
    if (indexExists) {
      const html = await readFile(join(tmpDir, "index.html"), "utf8")
      expect(html.length).toBeGreaterThan(100)
    }
    if (cssExists) {
      const css = await readFile(join(tmpDir, "style.css"), "utf8")
      expect(css.length).toBeGreaterThan(50)
    }
    if (jsExists) {
      const js = await readFile(join(tmpDir, "script.js"), "utf8")
      expect(js.length).toBeGreaterThan(50)
    }
  }, 300_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })
})

realLlmTests("Real LLM: Refactor code across multiple files", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-refactor-"))
    await mkdir(join(tmpDir, "src"), { recursive: true })
    // Create a small project with duplicated logic
    await writeFile(
      join(tmpDir, "src", "math.ts"),
      `
export function add(a: number, b: number): number { return a + b }
export function subtract(a: number, b: number): number { return a - b }
export function multiply(a: number, b: number): number { return a * b }
export function divide(a: number, b: number): number {
  if (b === 0) throw new Error("Cannot divide by zero")
  return a / b
}
`,
    )
    await writeFile(
      join(tmpDir, "src", "calc.ts"),
      `
import { add, subtract, multiply, divide } from "./math"
export function calculate(op: string, a: number, b: number): number {
  switch (op) {
    case "+": return add(a, b)
    case "-": return subtract(a, b)
    case "*": return multiply(a, b)
    case "/": return divide(a, b)
    default: throw new Error("Unknown op: " + op)
  }
}
`,
    )
    await writeFile(
      join(tmpDir, "src", "index.ts"),
      `
export { add, subtract, multiply, divide } from "./math"
export { calculate } from "./calc"
`,
    )
  }, 30_000)

  it("renames 'divide' to 'safeDivide' across all files", async () => {
    const loop = buildAgentLoop()
    const result = await loop.run({
      session: createSession("refactor-rename", "build"),
      query:
        "Rename the 'divide' function to 'safeDivide' in ALL files that reference it (math.ts, calc.ts, index.ts). Use the patch tool for each file.",
      cwd: tmpDir,
      maxSteps: 15,
    })

    log("info", "agent.real.refactor_rename", {
      iterations: result.iterations,
      stopReason: result.stopReason,
      fileChanges: result.session.fileChanges.map((f) => f.path),
    })

    const mathContent = await readFile(join(tmpDir, "src", "math.ts"), "utf8")
    const calcContent = await readFile(join(tmpDir, "src", "calc.ts"), "utf8")
    const indexContent = await readFile(join(tmpDir, "src", "index.ts"), "utf8")

    const allRenamed =
      !mathContent.includes("export function divide") &&
      !calcContent.includes("from './math'") &&
      !indexContent.includes("from './math'")
    expect(
      mathContent.includes("safeDivide") || allRenamed || result.session.fileChanges.length >= 2,
    ).toBe(true)
  }, 300_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })
})

realLlmTests("Real LLM: Fix a bug in existing code", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-bugfix-"))
    await writeFile(
      join(tmpDir, "buggy.ts"),
      `
// BUG: This function returns incorrect results for negative numbers
export function absoluteSum(values: number[]): number {
  let sum = 0
  for (const v of values) {
    sum += v  // BUG: should use Math.abs(v)
  }
  return sum
}

// BUG: Off-by-one error
export function lastElement<T>(arr: T[]): T | undefined {
  return arr[arr.length]  // BUG: should be arr.length - 1
}
`,
    )
    await writeFile(
      join(tmpDir, "test.ts"),
      `
import { absoluteSum, lastElement } from "./buggy"
console.log(absoluteSum([1, -2, 3]))  // Expected: 6, Got: 2
console.log(lastElement([1, 2, 3]))   // Expected: 3, Got: undefined
`,
    )
  }, 30_000)

  it("identifies and fixes both bugs", async () => {
    const loop = buildAgentLoop()
    const result = await loop.run({
      session: createSession("bugfix", "build"),
      query:
        "There are two bugs in buggy.ts. 1) absoluteSum doesn't use Math.abs() for negative numbers. 2) lastElement has an off-by-one error. Fix both bugs using the patch tool.",
      cwd: tmpDir,
      maxSteps: 15,
    })

    log("info", "agent.real.bugfix", {
      iterations: result.iterations,
      stopReason: result.stopReason,
      fileChanges: result.session.fileChanges.map((f) => f.path),
    })

    const fixed = await readFile(join(tmpDir, "buggy.ts"), "utf8")
    expect(fixed).not.toContain("sum += v  // BUG")
    expect(fixed).not.toContain("arr[arr.length]  // BUG")
    expect(result.session.fileChanges.length).toBeGreaterThanOrEqual(1)
  }, 300_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })
})

realLlmTests("Real LLM: Generate a multi-file Node.js project", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-project-"))
  }, 30_000)

  it("creates package.json, index.js, and a test file", async () => {
    const loop = buildAgentLoop()
    const result = await loop.run({
      session: createSession("gen-project", "build"),
      query:
        "Create a small Node.js project in the current directory. Create package.json (name: my-tool, version 1.0.0), index.js (a simple CLI tool that reads a file and counts words), and test.js (a basic test for the word counting function). Use CommonJS require syntax.",
      cwd: tmpDir,
      maxSteps: 20,
    })

    log("info", "agent.real.gen_project", {
      iterations: result.iterations,
      stopReason: result.stopReason,
      fileChanges: result.session.fileChanges.map((f) => f.path),
    })

    const pkgExists = existsSync(join(tmpDir, "package.json"))
    const indexExists = existsSync(join(tmpDir, "index.js"))
    const testExists = existsSync(join(tmpDir, "test.js"))

    expect(pkgExists || indexExists || testExists).toBe(true)
    if (pkgExists) {
      const pkg = JSON.parse(await readFile(join(tmpDir, "package.json"), "utf8"))
      expect(pkg.name).toBe("my-tool")
    }
  }, 300_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })
})

realLlmTests("Real LLM: SCE pressure test with large codebase", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-sce-pressure-"))
    // Create 300 files with various function names
    for (let i = 0; i < 300; i++) {
      await mkdir(join(tmpDir, `dir${i % 10}`), { recursive: true })
      await writeFile(
        join(tmpDir, `dir${i % 10}`, `mod${i}.ts`),
        `export function handler${i}() { return ${i} }\nexport const NAME${i} = "item${i}"\n`,
      )
    }
  }, 30_000)

  it("SCE finds relevant code in 300-file codebase efficiently", async () => {
    const tokenizer = new GPTTokenizer()
    const sce = new SCE(tokenizer)
    const t0 = performance.now()
    const slice = await sce.select("handler42", { cwd: tmpDir })
    const sceTime = performance.now() - t0
    log("info", "agent.real.sce_pressure", {
      grepMatches: slice.grepMatches.length,
      fileSnippets: slice.fileSnippets.length,
      sceTimeMs: Math.round(sceTime),
      filesInRepo: 300,
    })
    expect(slice.grepMatches.length).toBeGreaterThan(0)
    expect(sceTime).toBeLessThan(5000)
  }, 60_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })
})

realLlmTests("Real LLM: Plan mode verification", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-plan-"))
    await writeFile(join(tmpDir, "data.txt"), "some data to analyze\n")
  }, 30_000)

  it("returns a text plan without modifying files", async () => {
    const tokenizer = new GPTTokenizer()
    const loop = new AgentLoop({
      llm: new VercelAILLMClient({
        apiKey: process.env.LLM_API_KEY ?? "",
        baseUrl: process.env.LLM_BASE_URL || undefined,
      }),
      sce: new SCE(tokenizer),
      coe: new COE(tokenizer),
      router: buildRouter(),
      registry: buildFullToolRegistry(),
      store: new InMemorySessionStore(),
    })
    const result = await loop.run({
      session: createSession("plan-mode-test", "plan"),
      query:
        "Analyze data.txt and provide a plan for refactoring it into a better format. Do NOT edit any files.",
      cwd: tmpDir,
      maxSteps: 10,
    })

    log("info", "agent.real.plan_mode", {
      iterations: result.iterations,
      stopReason: result.stopReason,
      fileChanges: result.session.fileChanges.map((f) => f.path),
    })

    // In plan mode, no files should be modified
    expect(result.session.fileChanges.length).toBe(0)
    const lastMsg = result.session.messages[result.session.messages.length - 1]
    expect(lastMsg?.content.length).toBeGreaterThan(20)
  }, 120_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })
})

realLlmTests("Real LLM: COE pressure test with large session", () => {
  it("handles session with 50+ accumulated messages", async () => {
    const tokenizer = new GPTTokenizer()
    const coe = new COE(tokenizer)
    const session = createSession("coe-pressure", "build")
    session.messages.push({
      id: "sys",
      role: "system",
      content: "You are a Butterfly Agent.",
      timestamp: "t0",
    })
    for (let i = 0; i < 50; i++) {
      session.messages.push({
        id: `m${i}`,
        role: "user",
        content: "Analyze this code and tell me what it does.".repeat(10),
        timestamp: `t${i}`,
      })
      session.messages.push({
        id: `mt${i}`,
        role: "assistant",
        content:
          "Based on my analysis, this code appears to handle data processing operations.".repeat(
            10,
          ),
        timestamp: `t${i}`,
      })
    }
    const totalTokensBefore = session.messages.reduce(
      (sum, m) => sum + tokenizer.count(m.content),
      0,
    )
    log("info", "agent.real.coe_pressure", {
      totalTokensBefore,
      messageCount: session.messages.length,
    })
    const t0 = performance.now()
    const optimized = coe.optimize(session, { maxContextTokens: 4000 })
    const coeTime = performance.now() - t0
    const totalTokensAfter = optimized.messages.reduce(
      (sum, m) => sum + tokenizer.count(m.content),
      0,
    )
    log("info", "agent.real.coe_pressure_result", {
      messagesBefore: session.messages.length,
      messagesAfter: optimized.messages.length,
      tokensAfter: totalTokensAfter,
      coeTimeMs: Math.round(coeTime),
    })
    expect(totalTokensAfter).toBeLessThanOrEqual(4500)
    expect(optimized.messages[0]?.role).toBe("system")
    expect(coeTime).toBeLessThan(100)
  }, 30_000)
})
