import { describe, expect, it } from "vitest"
import { COE } from "../packages/context/src/coe"
import { GPTTokenizer } from "../packages/context/src/tokenizer"
import type { SessionState } from "../packages/session/src/types"
import { createSession } from "../packages/session/src/types"

function makeState(overrides?: Partial<SessionState>): SessionState {
  return {
    ...createSession("test-coe", "build"),
    ...overrides,
  }
}

let msgCounter = 0
function makeMsg(role: string, content: string, id?: string) {
  const seq = ++msgCounter
  if (role === "tool") {
    return {
      id: id ?? `t-${seq}`,
      role: "tool" as const,
      content,
      toolCallId: `tc-${seq}`,
      timestamp: new Date().toISOString(),
    }
  }
  return {
    id: id ?? `m-${seq}`,
    role: role as "user" | "assistant" | "system",
    content,
    timestamp: new Date().toISOString(),
  }
}

describe("@butterfly/context — COE", () => {
  const tokenizer = new GPTTokenizer()
  const coe = new COE(tokenizer)

  it("does not modify state when under budget", async () => {
    const state = makeState({
      messages: [makeMsg("user", "hello")],
    })
    const result = await coe.optimize(state, { maxContextTokens: 10_000 })
    expect(result.messages).toHaveLength(1)
    expect(result.warnings).toHaveLength(0)
  })

  it("deduplicates toolCalls by id (keeps last)", async () => {
    const state = makeState()
    state.toolCalls = [
      { id: "tc-a", name: "read", input: {}, startedAt: new Date().toISOString() },
      { id: "tc-b", name: "write", input: {}, startedAt: new Date().toISOString() },
      { id: "tc-a", name: "read", input: { path: "updated" }, startedAt: new Date().toISOString() },
    ]
    const result = await coe.optimize(state, { maxContextTokens: 10_000 })
    expect(result.toolCalls).toHaveLength(2)
    const tcA = result.toolCalls.find((tc) => tc.id === "tc-a")
    expect(tcA?.input).toEqual({ path: "updated" })
  })

  it("truncates long tool messages", async () => {
    const longText = "x".repeat(10_000)
    const state = makeState({
      messages: [makeMsg("tool", longText), makeMsg("tool", "short tool msg")],
    })
    const result = await coe.optimize(state, {
      maxContextTokens: 10_000,
      toolMessageMaxTokens: 5,
    })
    // First tool message should be truncated.
    expect(result.messages[0].content.length).toBeLessThan(longText.length)
    // Second should be untouched (under the cap).
    expect(result.messages[1].content).toBe("short tool msg")
  })

  it("drops oldest message groups when over budget", async () => {
    // Build a session with many messages that exceed the token budget.
    const messages = []
    for (let i = 0; i < 20; i++) {
      messages.push(makeMsg("assistant", `Using tools: step-${i}`))
      messages.push(makeMsg("tool", `tool result for step-${i}`, `t-${i}`))
    }
    const state = makeState({ messages })
    const result = await coe.optimize(state, { maxContextTokens: 100 })
    // Should have dropped many groups and kept at least system + last 2.
    expect(result.messages.length).toBeLessThan(messages.length)
    expect(result.messages.length).toBeGreaterThanOrEqual(2)
  })

  it("preserves system message when dropping groups", async () => {
    const state = makeState({
      messages: [
        makeMsg("system", "You are a helpful assistant."),
        makeMsg("assistant", "Using tools: step-1"),
        makeMsg("tool", "tool result 1"),
        makeMsg("assistant", "Using tools: step-2"),
        makeMsg("tool", "tool result 2"),
      ],
    })
    const result = await coe.optimize(state, { maxContextTokens: 5 })
    // System message should always be preserved.
    expect(result.messages[0].role).toBe("system")
    expect(result.messages[0].content).toBe("You are a helpful assistant.")
  })

  it("warns when budget cannot be met", async () => {
    // Create a single message that's over budget on its own.
    const hugeText = "x".repeat(50_000)
    const state = makeState({
      messages: [makeMsg("user", hugeText)],
    })
    const result = await coe.optimize(state, { maxContextTokens: 5 })
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain("Token budget exceeded")
  })

  it("throws on invalid maxContextTokens", async () => {
    const state = makeState()
    await expect(coe.optimize(state, { maxContextTokens: 0 })).rejects.toThrow(
      "invalid maxContextTokens",
    )
    await expect(coe.optimize(state, { maxContextTokens: -1 })).rejects.toThrow(
      "invalid maxContextTokens",
    )
    await expect(coe.optimize(state, { maxContextTokens: Number.NaN })).rejects.toThrow(
      "invalid maxContextTokens",
    )
  })

  it("does not mutate the input state", async () => {
    const original = makeState({
      messages: [makeMsg("user", "hello")],
    })
    const originalMessages = [...original.messages]
    await coe.optimize(original, { maxContextTokens: 10_000 })
    // Original state must be unchanged.
    expect(original.messages).toEqual(originalMessages)
  })

  it("drops complete tool-call groups — never orphans tool results", async () => {
    // Build: [user, assistant(Using tools), tool, assistant(Final), tool]
    // The last tool message is orphaned (no preceding "Using tools:" marker).
    // COE should handle this gracefully by treating it as a standalone group.
    const state = makeState({
      messages: [
        makeMsg("user", "do something"),
        makeMsg("assistant", "Using tools: step-1"),
        makeMsg("tool", "result 1"),
        makeMsg("assistant", "final response"),
        makeMsg("tool", "orphaned result"),
      ],
    })
    const result = await coe.optimize(state, { maxContextTokens: 50 })
    // Should not crash on orphaned tool messages.
    expect(result.messages.length).toBeGreaterThanOrEqual(2)
  })
})
