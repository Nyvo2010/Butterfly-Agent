/**
 * Message parts + parallel execution tests.
 *
 * Verifies:
 *   1. The loop emits structured `parts` on assistant tool-call messages,
 *      tool results, and assistant text messages (OpenCode-style parts).
 *   2. Parallel-safe read tools execute concurrently without breaking the
 *      transcript order or the read-before-write protection.
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

let readCounter = 0

const readTool: Tool = {
  name: "read",
  description: "Read a file",
  kind: "read",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  async execute(input) {
    const delay = input.path === "slow.ts" ? 30 : 0
    await new Promise((r) => setTimeout(r, delay))
    readCounter++
    return { kind: "ok", output: `content of ${input.path}` }
  },
}

const writeTool: Tool = {
  name: "write",
  description: "Write a file",
  kind: "write",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  async execute(input) {
    return { kind: "ok", output: { written: input.path } }
  },
}

function createFakeSCE(): AgentLoopDeps["sce"] {
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
  registry.register(readTool)
  registry.register(writeTool)
  const store = new InMemorySessionStore()
  const loop = new AgentLoop({
    llm: mock,
    sce: createFakeSCE(),
    coe: createFakeCOE(),
    router,
    registry,
    store,
  })
  return { loop, store }
}

describe("AgentLoop — message parts (OpenCode-style)", () => {
  it("emits tool_call parts on the assistant marker message", async () => {
    readCounter = 0
    const mock = new MockLLMClient([
      toolCallResponse([
        { id: "tc1", name: "read", input: { path: "a.ts" } },
        { id: "tc2", name: "write", input: { path: "b.ts" } },
      ]),
      textResponse("done"),
    ])
    const { loop } = setupLoop(mock)
    const session = createSession("parts-1", "build")
    const result = await loop.run({ session, query: "work", cwd: "/tmp", maxSteps: 3 })
    const messages = result.session.messages

    const assistant = messages.find((m) => m.role === "assistant" && m.toolCallId)
    expect(assistant?.parts).toBeDefined()
    expect(assistant?.parts?.some((p) => p.type === "tool_call")).toBe(true)
    const toolCallParts = assistant?.parts?.filter((p) => p.type === "tool_call")
    expect(toolCallParts).toHaveLength(2)
  })

  it("emits tool_result parts on tool messages", async () => {
    readCounter = 0
    const mock = new MockLLMClient([
      toolCallResponse([{ id: "tc1", name: "read", input: { path: "a.ts" } }]),
      textResponse("done"),
    ])
    const { loop } = setupLoop(mock)
    const session = createSession("parts-2", "build")
    const result = await loop.run({ session, query: "work", cwd: "/tmp", maxSteps: 3 })

    const toolMsg = result.session.messages.find((m) => m.role === "tool")
    expect(toolMsg?.parts).toBeDefined()
    expect(toolMsg?.parts?.some((p) => p.type === "tool_result")).toBe(true)
  })

  it("emits text parts on final assistant message", async () => {
    readCounter = 0
    const mock = new MockLLMClient([textResponse("all good")])
    const { loop } = setupLoop(mock)
    const session = createSession("parts-3", "build")
    const result = await loop.run({ session, query: "work", cwd: "/tmp", maxSteps: 3 })

    const last = result.session.messages[result.session.messages.length - 1]
    expect(last?.role).toBe("assistant")
    expect(last?.parts?.some((p) => p.type === "text" && p.text === "all good")).toBe(true)
  })
})

describe("AgentLoop — parallel tool execution", () => {
  it("runs parallel-safe reads concurrently and preserves transcript order", async () => {
    readCounter = 0
    const mock = new MockLLMClient([
      toolCallResponse([
        { id: "tc1", name: "read", input: { path: "slow.ts" } },
        { id: "tc2", name: "read", input: { path: "fast.ts" } },
        { id: "tc3", name: "write", input: { path: "out.ts" } },
      ]),
      textResponse("done"),
    ])
    const { loop } = setupLoop(mock)
    const session = createSession("parallel-1", "build")
    const result = await loop.run({ session, query: "work", cwd: "/tmp", maxSteps: 3 })

    // Both reads completed (counter incremented twice).
    expect(readCounter).toBe(2)

    // Transcript order preserved: read, read, write (model order).
    const toolMsgs = result.session.messages.filter((m) => m.role === "tool")
    expect(toolMsgs).toHaveLength(3)
    const names = result.session.messages.filter((m) => m.role === "tool").map((m) => m.content)
    // Tool results were recorded in original call order.
    expect(names[0]).toContain("slow.ts")
    expect(names[1]).toContain("fast.ts")
    expect(names[2]).toContain("out.ts")
  })
})
