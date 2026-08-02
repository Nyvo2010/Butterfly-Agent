/**
 * Tests for slash-command resolution, external file references, and
 * cost-per-session tracking.
 *
 * These features were added to make the backend ready for a future client:
 *   - Slash commands: /<name> [args] in the query → resolved against the
 *     configured commands map before the loop runs.
 *   - External file references: @path/to/file.ts in the query → read and
 *     injected into the first user message as context.
 *   - Cost tracking: estimated USD cost accumulated from catalog pricing.
 */
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AgentLoop } from "../packages/agent/src/loop"
import { ModelRouter } from "../packages/agent/src/router"
import { extractRefs } from "../packages/server/src/routes/session"
import { InMemorySessionStore } from "../packages/session/src"
import type { SessionState } from "../packages/session/src/types"
import { createSession } from "../packages/session/src/types"
import { ToolRegistry } from "../packages/tools/src/registry"
import type { Tool } from "../packages/tools/src/types"
import { MockLLMClient, textResponse, toolCallResponse } from "./mock-llm"

// ── Test fixtures ─────────────────────────────────────────────────────────────

const listTool: Tool = {
  name: "list",
  description: "Lists directory entries",
  kind: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    return { kind: "ok", output: { entries: [] } }
  },
}

function createFakeSCE(): import("../packages/agent/src/loop").AgentLoopDeps["sce"] {
  // SCE has private fields — only the public interface matters for tests.
  return {
    async select() {
      return { grepMatches: [], fileSnippets: [], warnings: [] }
    },
  } as unknown as import("../packages/agent/src/loop").AgentLoopDeps["sce"]
}

function createFakeCOE(): import("../packages/agent/src/loop").AgentLoopDeps["coe"] {
  // COE has private fields — only the public interface matters for tests.
  return {
    async optimize(state: SessionState) {
      return { ...state, warnings: [] }
    },
  } as unknown as import("../packages/agent/src/loop").AgentLoopDeps["coe"]
}

function setupLoop(mock: MockLLMClient) {
  const router = new ModelRouter({
    tierMapping: {
      trivial: "mock-trivial",
      standard: "mock-standard",
      complex: "mock-complex",
      escalate: "mock-escalate",
    },
    escalationLimit: 3,
  })
  const registry = new ToolRegistry()
  registry.register(listTool)
  const store = new InMemorySessionStore()

  const loop = new AgentLoop({
    llm: mock,
    sce: createFakeSCE(),
    coe: createFakeCOE(),
    router,
    registry,
    store,
  })

  return { loop, store, mock }
}

// ── Slash command resolution ─────────────────────────────────────────────────

describe("AgentLoop — slash command resolution", () => {
  it("rewrites /<name> args into the command template", async () => {
    // Capture the query the LLM actually receives.
    let seenQuery = ""
    const mock = new MockLLMClient((req) => {
      seenQuery = String(req.messages.find((m) => m.role === "user")?.content ?? "")
      return textResponse("Done!")
    })
    const { loop } = setupLoop(mock)

    const session = createSession("s-cmd-1", "build")
    await loop.run({
      session,
      query: "/fix the login button",
      cwd: "/tmp",
      maxSteps: 3,
      commands: {
        fix: "Fix the following issue: {args}",
        test: "Write tests for: {args}",
      },
    })

    expect(seenQuery).toContain("Fix the following issue: the login button")
  })

  it("handles a command with no args (empty {args})", async () => {
    let seenQuery = ""
    const mock = new MockLLMClient((req) => {
      seenQuery = String(req.messages.find((m) => m.role === "user")?.content ?? "")
      return textResponse("Done!")
    })
    const { loop } = setupLoop(mock)

    const session = createSession("s-cmd-2", "build")
    await loop.run({
      session,
      query: "/explain",
      cwd: "/tmp",
      maxSteps: 3,
      commands: { explain: "Explain this project: {args}" },
    })

    expect(seenQuery).toContain("Explain this project:")
  })

  it("leaves unknown commands as-is", async () => {
    let seenQuery = ""
    const mock = new MockLLMClient((req) => {
      seenQuery = String(req.messages.find((m) => m.role === "user")?.content ?? "")
      return textResponse("Done!")
    })
    const { loop } = setupLoop(mock)

    const session = createSession("s-cmd-3", "build")
    await loop.run({
      session,
      query: "/doesnotexist hello",
      cwd: "/tmp",
      maxSteps: 3,
      commands: { fix: "Fix: {args}" },
    })

    expect(seenQuery).toContain("/doesnotexist hello")
  })

  it("does nothing when no commands map is configured", async () => {
    let seenQuery = ""
    const mock = new MockLLMClient((req) => {
      seenQuery = String(req.messages.find((m) => m.role === "user")?.content ?? "")
      return textResponse("Done!")
    })
    const { loop } = setupLoop(mock)

    const session = createSession("s-cmd-4", "build")
    await loop.run({
      session,
      query: "/fix hello",
      cwd: "/tmp",
      maxSteps: 3,
    })

    expect(seenQuery).toContain("/fix hello")
  })

  it("supports a command template with no {args} placeholder", async () => {
    let seenQuery = ""
    const mock = new MockLLMClient((req) => {
      seenQuery = String(req.messages.find((m) => m.role === "user")?.content ?? "")
      return textResponse("Done!")
    })
    const { loop } = setupLoop(mock)

    const session = createSession("s-cmd-5", "build")
    await loop.run({
      session,
      query: "/deploy",
      cwd: "/tmp",
      maxSteps: 3,
      commands: { deploy: "Deploy the project now." },
    })

    expect(seenQuery).toContain("Deploy the project now.")
  })
})

// ── External file references ─────────────────────────────────────────────────

describe("AgentLoop — external file references", () => {
  it("injects referenced file content into the first user message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bf-refs-"))
    const filePath = join(dir, "utils.ts")
    await writeFile(filePath, "export function helper() { return 42 }", "utf8")

    let seenQuery = ""
    const mock = new MockLLMClient((req) => {
      seenQuery = String(req.messages.find((m) => m.role === "user")?.content ?? "")
      return textResponse("Done!")
    })
    const { loop } = setupLoop(mock)

    const session = createSession("s-ref-1", "build")
    await loop.run({
      session,
      query: "explain utils.ts",
      cwd: dir,
      maxSteps: 3,
      refs: ["utils.ts"],
    })

    expect(seenQuery).toContain("REFERENCED FILES:")
    expect(seenQuery).toContain("export function helper() { return 42 }")
    expect(seenQuery).toContain("--- utils.ts ---")
  })

  it("gracefully reports missing referenced files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bf-refs-"))

    let seenQuery = ""
    const mock = new MockLLMClient((req) => {
      seenQuery = String(req.messages.find((m) => m.role === "user")?.content ?? "")
      return textResponse("Done!")
    })
    const { loop } = setupLoop(mock)

    const session = createSession("s-ref-2", "build")
    await loop.run({
      session,
      query: "check missing.ts",
      cwd: dir,
      maxSteps: 3,
      refs: ["missing.ts"],
    })

    expect(seenQuery).toContain("[SKIPPED: missing.ts — could not read]")
  })

  it("skips oversized referenced files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bf-refs-"))
    const filePath = join(dir, "big.ts")
    // Write ~1.1MB so it exceeds the 1MB cap.
    await writeFile(filePath, "x".repeat(1_100_000), "utf8")

    let seenQuery = ""
    const mock = new MockLLMClient((req) => {
      seenQuery = String(req.messages.find((m) => m.role === "user")?.content ?? "")
      return textResponse("Done!")
    })
    const { loop } = setupLoop(mock)

    const session = createSession("s-ref-3", "build")
    await loop.run({
      session,
      query: "read big.ts",
      cwd: dir,
      maxSteps: 3,
      refs: ["big.ts"],
    })

    expect(seenQuery).toContain("[SKIPPED: big.ts — file too large")
    expect(seenQuery).not.toContain("xxxxx") // content not inlined
  })

  it("handles absolute ref paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bf-refs-"))
    const filePath = join(dir, "abs.ts")
    await writeFile(filePath, "const ABS = true", "utf8")

    let seenQuery = ""
    const mock = new MockLLMClient((req) => {
      seenQuery = String(req.messages.find((m) => m.role === "user")?.content ?? "")
      return textResponse("Done!")
    })
    const { loop } = setupLoop(mock)

    const session = createSession("s-ref-4", "build")
    await loop.run({
      session,
      query: "check abs.ts",
      cwd: dir,
      maxSteps: 3,
      refs: [filePath], // absolute
    })

    expect(seenQuery).toContain("const ABS = true")
  })

  it("does not inject refs block when refs is empty", async () => {
    let seenQuery = ""
    const mock = new MockLLMClient((req) => {
      seenQuery = String(req.messages.find((m) => m.role === "user")?.content ?? "")
      return textResponse("Done!")
    })
    const { loop } = setupLoop(mock)

    const session = createSession("s-ref-5", "build")
    await loop.run({
      session,
      query: "plain query",
      cwd: "/tmp",
      maxSteps: 3,
    })

    expect(seenQuery).not.toContain("REFERENCED FILES:")
  })
})

// ── extractRefs helper ────────────────────────────────────────────────────────

describe("extractRefs — @path extraction from prompts", () => {
  it("extracts @path/to/file.ts references", () => {
    const refs = extractRefs("Refactor @src/utils.ts and @src/index.ts")
    expect(refs).toEqual(["src/utils.ts", "src/index.ts"])
  })

  it("deduplicates repeated references", () => {
    const refs = extractRefs("@src/utils.ts is used by @src/utils.ts")
    expect(refs).toEqual(["src/utils.ts"])
  })

  it("requires a file extension", () => {
    expect(extractRefs("@src/utils")).toEqual([])
    expect(extractRefs("@README.md")).toEqual(["README.md"])
  })

  it("does not match plain email-like or handle syntax", () => {
    expect(extractRefs("contact @team now")).toEqual([])
  })

  it("handles hyphenated and dotted paths", () => {
    const refs = extractRefs("check @packages/llm/src/client.ts and @foo-bar.ts")
    expect(refs).toContain("packages/llm/src/client.ts")
    expect(refs).toContain("foo-bar.ts")
  })
})

// ── Cost tracking ─────────────────────────────────────────────────────────────

describe("AgentLoop — cost tracking", () => {
  it("accumulates estimated cost from pricing", async () => {
    // 1000 prompt tokens @ $1/1M + 500 completion @ $2/1M = $0.001 + $0.001 = $0.002
    const mock = new MockLLMClient([
      textResponse("Done!", {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        usageAvailable: true,
      }),
    ])

    const router = new ModelRouter({
      tierMapping: {
        trivial: "test/model",
        standard: "test/model",
        complex: "test/model",
        escalate: "test/model",
      },
      escalationLimit: 3,
    })
    const registry = new ToolRegistry()
    registry.register(listTool)
    const store = new InMemorySessionStore()

    // ProviderService stub with a fixed price.
    const providerService = {
      costFor: async () => ({ input: 1, output: 2 }),
      getClient: () => mock,
    } as unknown as import("../packages/agent/src/loop").AgentLoopDeps["providerService"]

    const loop = new AgentLoop({
      llm: mock,
      providerService,
      sce: createFakeSCE(),
      coe: createFakeCOE(),
      router,
      registry,
      store,
    })

    const session = createSession("s-cost-1", "build")
    const result = await loop.run({
      session,
      query: "test cost",
      cwd: "/tmp",
      maxSteps: 3,
    })

    expect(result.session.usage?.promptTokens).toBe(1000)
    expect(result.session.usage?.completionTokens).toBe(500)
    expect(result.session.usage?.costUsd).toBeCloseTo(0.002, 6)
  })

  it("leaves costUsd undefined when pricing is unknown", async () => {
    const mock = new MockLLMClient([
      textResponse("Done!", {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        usageAvailable: true,
      }),
    ])
    const router = new ModelRouter({
      tierMapping: {
        trivial: "test/model",
        standard: "test/model",
        complex: "test/model",
        escalate: "test/model",
      },
      escalationLimit: 3,
    })
    const registry = new ToolRegistry()
    registry.register(listTool)
    const store = new InMemorySessionStore()

    const providerService = {
      costFor: async () => undefined,
      getClient: () => mock,
    } as unknown as import("../packages/agent/src/loop").AgentLoopDeps["providerService"]

    const loop = new AgentLoop({
      llm: mock,
      providerService,
      sce: createFakeSCE(),
      coe: createFakeCOE(),
      router,
      registry,
      store,
    })

    const session = createSession("s-cost-2", "build")
    const result = await loop.run({
      session,
      query: "test no pricing",
      cwd: "/tmp",
      maxSteps: 3,
    })

    expect(result.session.usage?.costUsd).toBe(0)
  })

  it("accumulates cost across multiple LLM calls", async () => {
    const usage = () => ({
      promptTokens: 1000,
      completionTokens: 1000,
      totalTokens: 2000,
      usageAvailable: true,
    })
    const mock = new MockLLMClient([
      toolCallResponse([{ id: "tc1", name: "list", input: {} }], usage()),
      textResponse("Done!", usage()),
    ])

    const router = new ModelRouter({
      tierMapping: {
        trivial: "test/model",
        standard: "test/model",
        complex: "test/model",
        escalate: "test/model",
      },
      escalationLimit: 3,
    })
    const registry = new ToolRegistry()
    registry.register(listTool)
    const store = new InMemorySessionStore()

    const providerService = {
      costFor: async () => ({ input: 1, output: 1 }),
      getClient: () => mock,
    } as unknown as import("../packages/agent/src/loop").AgentLoopDeps["providerService"]

    const loop = new AgentLoop({
      llm: mock,
      providerService,
      sce: createFakeSCE(),
      coe: createFakeCOE(),
      router,
      registry,
      store,
    })

    const session = createSession("s-cost-3", "build")
    const result = await loop.run({
      session,
      query: "test multi",
      cwd: "/tmp",
      maxSteps: 5,
    })

    // Two calls: each (1000/1e6)*1 + (1000/1e6)*1 = $0.002 → $0.004 total.
    expect(result.session.usage?.callCount).toBe(2)
    expect(result.session.usage?.costUsd).toBeCloseTo(0.004, 6)
  })
})
