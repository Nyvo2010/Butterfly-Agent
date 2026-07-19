import { COE, GPTTokenizer } from "@butterfly/context"
import type { SessionState } from "@butterfly/session"
import { createSession } from "@butterfly/session"
import { beforeEach, describe, expect, it } from "vitest"

describe("COE advanced", () => {
  let tok: GPTTokenizer
  let coe: COE

  beforeEach(() => {
    tok = new GPTTokenizer()
    coe = new COE(tok)
  })

  function makeSession(overrides: Partial<SessionState> = {}): SessionState {
    return { ...createSession("coe-advanced", "build"), ...overrides }
  }

  it("handles session with only system message", () => {
    const state = makeSession({
      messages: [{ id: "sys", role: "system", content: "You are Butterfly.", timestamp: "t0" }],
    })
    const opt = coe.optimize(state, { maxContextTokens: 100 })
    expect(opt.messages).toHaveLength(1)
    expect(opt.messages[0].role).toBe("system")
  })

  it("handles session with no messages at all", () => {
    const state = makeSession({ messages: [] })
    const opt = coe.optimize(state, { maxContextTokens: 100 })
    expect(opt.messages).toEqual([])
  })

  it("handles messages with zero-length content", () => {
    const state = makeSession({
      messages: [
        { id: "sys", role: "system", content: "sys", timestamp: "t0" },
        { id: "m1", role: "user", content: "", timestamp: "t1" },
        { id: "m2", role: "tool", content: "", toolCallId: "tc1", timestamp: "t2" },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 100 })
    expect(opt.messages.length).toBeGreaterThan(0)
  })

  it("does not modify state when already under cap", () => {
    const state = makeSession({
      messages: [
        { id: "sys", role: "system", content: "sys", timestamp: "t0" },
        { id: "m1", role: "user", content: "hi", timestamp: "t1" },
        { id: "m2", role: "assistant", content: "hello", timestamp: "t2" },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 99999 })
    expect(opt.messages).toHaveLength(3)
    expect(opt.messages[0].content).toBe("sys")
    expect(opt.messages[1].content).toBe("hi")
    expect(opt.messages[2].content).toBe("hello")
  })

  it("preserves system message when it's the only message", () => {
    const state = makeSession({
      messages: [
        {
          id: "sys",
          role: "system",
          content: "critical system prompt that must survive",
          timestamp: "t0",
        },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 1 })
    expect(opt.messages).toHaveLength(1)
    expect(opt.messages[0].content).toBe("critical system prompt that must survive")
  })

  it("handles massive session (1000 messages)", () => {
    const msgs: Array<{
      id: string
      role: "user" | "tool"
      content: string
      toolCallId?: string
      timestamp: string
    }> = []
    for (let i = 0; i < 1000; i++) {
      msgs.push({ id: `m${i}`, role: "user", content: `message content ${i}`, timestamp: `t${i}` })
    }
    const state = makeSession({
      messages: [{ id: "sys", role: "system", content: "sys", timestamp: "t0" }, ...msgs],
    })
    const opt = coe.optimize(state, { maxContextTokens: 500 })
    expect(opt.messages.length).toBeLessThan(1001)
    expect(opt.messages[0]?.role).toBe("system")
    const totalTokens = opt.messages.reduce((s, m) => s + tok.count(m.content), 0)
    expect(totalTokens).toBeLessThanOrEqual(550)
  })

  it("handles 1000 duplicate tool call IDs", () => {
    const tcIds = Array.from({ length: 1000 }, (_, i) => `dup-${i % 5}`)
    const toolCalls = tcIds.map((id, i) => ({
      id,
      name: "read",
      input: { path: `f${i}.txt` },
      result: `result${i}`,
      startedAt: `t${i}`,
      finishedAt: `t${i}`,
    }))
    const state = makeSession({ toolCalls })
    const opt = coe.optimize(state, { maxContextTokens: 99999 })
    expect(opt.toolCalls.length).toBe(5)
  })

  it("handles mix of all message roles", () => {
    const state = makeSession({
      messages: [
        { id: "sys", role: "system", content: "system", timestamp: "t0" },
        { id: "m1", role: "user", content: "user msg", timestamp: "t1" },
        { id: "m2", role: "assistant", content: "assistant msg", timestamp: "t2" },
        { id: "m3", role: "tool", content: "x".repeat(5000), toolCallId: "tc1", timestamp: "t3" },
        { id: "m4", role: "user", content: "user msg 2", timestamp: "t4" },
        { id: "m5", role: "assistant", content: "assistant msg 2", timestamp: "t5" },
        { id: "m6", role: "tool", content: "y".repeat(5000), toolCallId: "tc2", timestamp: "t6" },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 3000, toolMessageMaxTokens: 500 })
    expect(opt.messages[0]?.role).toBe("system")
    const toolMsgs = opt.messages.filter((m) => m.role === "tool")
    for (const tm of toolMsgs) {
      expect(tok.count(tm.content)).toBeLessThanOrEqual(500)
    }
  })

  it("handles custom toolMessageMaxTokens", () => {
    const state = makeSession({
      messages: [
        { id: "sys", role: "system", content: "sys", timestamp: "t0" },
        { id: "m1", role: "tool", content: "x".repeat(10000), toolCallId: "tc1", timestamp: "t1" },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 99999, toolMessageMaxTokens: 50 })
    const toolMsg = opt.messages.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    expect(tok.count(toolMsg?.content ?? "")).toBeLessThanOrEqual(50)
  })

  it("is immutable: original state object is unchanged", () => {
    const state = makeSession({
      messages: [
        { id: "sys", role: "system", content: "sys", timestamp: "t0" },
        { id: "m1", role: "user", content: "a".repeat(5000), timestamp: "t1" },
        { id: "m2", role: "tool", content: "b".repeat(5000), toolCallId: "tc1", timestamp: "t2" },
      ],
    })
    const originalMsgCount = state.messages.length
    const originalToolCallCount = state.toolCalls.length
    coe.optimize(state, { maxContextTokens: 100 })
    expect(state.messages.length).toBe(originalMsgCount)
    expect(state.toolCalls.length).toBe(originalToolCallCount)
  })

  it("optimize called multiple times on same state is stable", () => {
    const state = makeSession({
      messages: [
        { id: "sys", role: "system", content: "sys", timestamp: "t0" },
        { id: "m1", role: "user", content: "a".repeat(3000), timestamp: "t1" },
        { id: "m2", role: "tool", content: "b".repeat(3000), toolCallId: "tc1", timestamp: "t2" },
        { id: "m3", role: "user", content: "c".repeat(3000), timestamp: "t3" },
      ],
    })
    const opt1 = coe.optimize(state, { maxContextTokens: 2000 })
    const opt2 = coe.optimize(state, { maxContextTokens: 2000 })
    expect(opt1.messages.length).toBe(opt2.messages.length)
    expect(opt1.toolCalls.length).toBe(opt2.toolCalls.length)
  })

  it("drops only oldest non-system messages when over cap", () => {
    const state = makeSession({
      messages: [
        {
          id: "sys",
          role: "system",
          content: "system prompt message that has many tokens",
          timestamp: "t0",
        },
        {
          id: "m1",
          role: "user",
          content:
            "long user message that definitely exceeds the tiny token cap we set for this test",
          timestamp: "t1",
        },
        {
          id: "m2",
          role: "user",
          content: "another long user message that also exceeds the token cap very easily now",
          timestamp: "t2",
        },
        {
          id: "m3",
          role: "user",
          content: "yet another long user message that makes the session far exceed the limit",
          timestamp: "t3",
        },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 10 })
    expect(opt.messages.length).toBeLessThan(4)
    expect(opt.messages[0]?.role).toBe("system")
    expect(opt.messages.every((m) => m.role === "system" || m.role === "user")).toBe(true)
  })
})
