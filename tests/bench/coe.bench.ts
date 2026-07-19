import { COE, GPTTokenizer } from "@butterfly/context"
import type { SessionMessage, SessionState, ToolCallRecord } from "@butterfly/session"
import { createSession } from "@butterfly/session"
import { bench, describe } from "vitest"

function makeManyMessages(
  count: number,
  toolRatio: number,
  contentSize: number,
): { messages: SessionMessage[]; toolCalls: ToolCallRecord[] } {
  const messages: SessionMessage[] = [
    { id: "sys", role: "system", content: "You are a Butterfly Agent.", timestamp: "t0" },
  ]
  const toolCalls: ToolCallRecord[] = []
  for (let i = 1; i <= count; i++) {
    const isTool = Math.random() < toolRatio
    const id = `m${i}`
    const content = "x".repeat(contentSize)
    if (isTool) {
      const tcId = `tc${i}`
      messages.push({ id, role: "tool", content, toolCallId: tcId, timestamp: `t${i}` })
      toolCalls.push({
        id: tcId,
        name: "read",
        input: {},
        result: content,
        startedAt: `t${i}`,
        finishedAt: `t${i}`,
      })
    } else {
      messages.push({ id, role: "user", content, timestamp: `t${i}` })
    }
  }
  return { messages, toolCalls }
}

describe("COE bench", () => {
  const tok = new GPTTokenizer()
  const coe = new COE(tok)

  bench("small session (10 messages)", () => {
    const { messages, toolCalls } = makeManyMessages(10, 0.3, 100)
    const state: SessionState = { ...createSession("b1", "build"), messages, toolCalls }
    coe.optimize(state, { maxContextTokens: 8000 })
  })

  bench("medium session (50 messages)", () => {
    const { messages, toolCalls } = makeManyMessages(50, 0.3, 500)
    const state: SessionState = { ...createSession("b2", "build"), messages, toolCalls }
    coe.optimize(state, { maxContextTokens: 8000 })
  })

  bench("large session (200 messages)", () => {
    const { messages, toolCalls } = makeManyMessages(200, 0.3, 2000)
    const state: SessionState = { ...createSession("b3", "build"), messages, toolCalls }
    coe.optimize(state, { maxContextTokens: 8000 })
  })

  bench("aggressive truncation (low token cap)", () => {
    const { messages, toolCalls } = makeManyMessages(100, 0.5, 1000)
    const state: SessionState = { ...createSession("b4", "build"), messages, toolCalls }
    coe.optimize(state, { maxContextTokens: 500 })
  })

  bench("many duplicate tool calls", () => {
    const messages: SessionMessage[] = [
      { id: "sys", role: "system", content: "sys", timestamp: "t0" },
    ]
    const toolCalls: ToolCallRecord[] = []
    for (let i = 0; i < 100; i++) {
      const tcId = "dup-tc"
      messages.push({
        id: `m${i}`,
        role: "tool",
        content: "result",
        toolCallId: tcId,
        timestamp: `t${i}`,
      })
      toolCalls.push({
        id: tcId,
        name: "read",
        input: {},
        result: "result",
        startedAt: `t${i}`,
        finishedAt: `t${i}`,
      })
    }
    const state: SessionState = { ...createSession("b5", "build"), messages, toolCalls }
    coe.optimize(state, { maxContextTokens: 8000 })
  })

  bench("just-over-cap session", () => {
    const { messages } = makeManyMessages(15, 0.3, 600)
    const state: SessionState = { ...createSession("b6", "build"), messages, toolCalls: [] }
    coe.optimize(state, { maxContextTokens: 7999 })
  })
})
