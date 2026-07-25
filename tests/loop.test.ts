/**
 * Agent loop unit tests — test the core execution engine deterministically
 * using the MockLLMClient.
 */
import { describe, expect, it } from "vitest"
import type { AgentLoopDeps } from "../packages/agent/src/loop"
import { AgentLoop } from "../packages/agent/src/loop"
import { ModelRouter } from "../packages/agent/src/router"
import { createSession, InMemorySessionStore } from "../packages/session/src"
import type { SessionState } from "../packages/session/src/types"
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

const alwaysFailsTool: Tool = {
  name: "fail_tool",
  description: "Always fails",
  kind: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    return { kind: "err", message: "always fails" }
  },
}

function createFakeSCE(): AgentLoopDeps["sce"] {
  // SCE has private fields (cache, tokenizer) — only the public interface
  // matters for tests. Double cast required since TypeScript checks private
  // class members across file boundaries and rejects direct casts.
  return {
    async select() {
      return { grepMatches: [], fileSnippets: [], warnings: [] }
    },
  } as unknown as AgentLoopDeps["sce"]
}

function createFakeCOE(): AgentLoopDeps["coe"] {
  return {
    async optimize(state: SessionState) {
      return { ...state, warnings: [] }
    },
  } as unknown as AgentLoopDeps["coe"]
}

function setupLoop(mock: MockLLMClient, tools: Tool[] = [listTool]) {
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
  for (const t of tools) registry.register(t)
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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("AgentLoop — basic behavior", () => {
  it("returns no_tool_calls when LLM responds with text", async () => {
    const mock = new MockLLMClient([textResponse("Done!")])
    const { loop } = setupLoop(mock)

    const session = createSession("test-1", "build")
    const result = await loop.run({
      session,
      query: "list files",
      cwd: "/tmp",
      maxSteps: 5,
    })

    expect(result.stopReason).toBe("no_tool_calls")
    expect(result.iterations).toBe(1)
    const lastMsg = result.session.messages[result.session.messages.length - 1]
    expect(lastMsg?.role).toBe("assistant")
    expect(lastMsg?.content).toBe("Done!")
  })

  it("executes tool calls and loops", async () => {
    const mock = new MockLLMClient([
      toolCallResponse([{ id: "tc1", name: "list", input: {} }]),
      textResponse("All done"),
    ])
    const { loop } = setupLoop(mock)

    const session = createSession("test-2", "build")
    const result = await loop.run({
      session,
      query: "list files",
      cwd: "/tmp",
      maxSteps: 5,
    })

    expect(result.iterations).toBe(2)
    expect(result.stopReason).toBe("no_tool_calls")
    expect(mock.consumed).toBe(2)
  })

  it("escalates tier when a tool fails", async () => {
    const mock = new MockLLMClient([
      toolCallResponse([{ id: "tc1", name: "fail_tool", input: {} }]),
      textResponse("Escalated and done"),
    ])
    const { loop } = setupLoop(mock, [alwaysFailsTool])

    const session = createSession("test-3", "build", "trivial")
    const result = await loop.run({
      session,
      query: "fail test",
      cwd: "/tmp",
      maxSteps: 5,
    })

    expect(result.session.tier).toBe("standard")
    expect(result.iterations).toBe(2)
  })

  it("stops at max_steps when loop exceeds limit", async () => {
    const mock = new MockLLMClient([
      toolCallResponse([{ id: "tc1", name: "list", input: {} }]),
      toolCallResponse([{ id: "tc2", name: "list", input: {} }]),
      toolCallResponse([{ id: "tc3", name: "list", input: {} }]),
      toolCallResponse([{ id: "tc4", name: "list", input: {} }]),
    ])
    const { loop } = setupLoop(mock)

    const session = createSession("test-4", "build")
    const result = await loop.run({
      session,
      query: "list forever",
      cwd: "/tmp",
      maxSteps: 3,
    })

    expect(result.stopReason).toBe("max_steps")
    expect(result.iterations).toBe(3)
  })

  it("appends bootstrap summary to first user message", async () => {
    const mock = new MockLLMClient([textResponse("Done")])
    const { loop } = setupLoop(mock)

    const session = createSession("test-5", "build")
    const result = await loop.run({
      session,
      query: "do something",
      cwd: "/tmp",
      maxSteps: 5,
      bootstrapSummary: "TypeScript + React + pnpm",
    })

    const firstMsg = result.session.messages[0]
    expect(firstMsg?.role).toBe("user")
    expect(firstMsg?.content).toContain("[Project context: TypeScript + React + pnpm]")
    expect(firstMsg?.content).toContain("do something")
  })
})

describe("AgentLoop — error handling", () => {
  it("throws on empty query", async () => {
    const mock = new MockLLMClient([])
    const { loop } = setupLoop(mock)
    const session = createSession("test-err", "build")
    await expect(loop.run({ session, query: "", cwd: "/tmp", maxSteps: 5 })).rejects.toThrow(
      "query is required",
    )
  })

  it("escalation caps at limit and returns error_max_escalation", async () => {
    const mock = new MockLLMClient([
      toolCallResponse([{ id: "tc1", name: "fail_tool", input: {} }]),
      toolCallResponse([{ id: "tc2", name: "fail_tool", input: {} }]),
      toolCallResponse([{ id: "tc3", name: "fail_tool", input: {} }]),
      toolCallResponse([{ id: "tc4", name: "fail_tool", input: {} }]),
      toolCallResponse([{ id: "tc5", name: "fail_tool", input: {} }]),
    ])
    const { loop } = setupLoop(mock, [alwaysFailsTool])

    const session = createSession("test-esc", "build", "trivial")
    const result = await loop.run({
      session,
      query: "fail forever",
      cwd: "/tmp",
      maxSteps: 10,
    })

    expect(result.stopReason).toBe("error_max_escalation")
    expect(result.lastResolution.escalationDepth).toBeGreaterThanOrEqual(3)
  })
})
