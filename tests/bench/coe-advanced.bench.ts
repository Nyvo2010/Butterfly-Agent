import { COE, GPTTokenizer } from "@butterfly/context"
import type { SessionMessage, SessionState, ToolCallRecord } from "@butterfly/session"
import { createSession } from "@butterfly/session"
import { bench, describe } from "vitest"

function makeSessionWithMessages(
  msgCount: number,
  contentSize: number,
): { messages: SessionMessage[]; toolCalls: ToolCallRecord[] } {
  const messages: SessionMessage[] = [
    {
      id: "sys",
      role: "system",
      content: "You are a Butterfly Agent in BUILD mode.",
      timestamp: "t0",
    },
  ]
  const toolCalls: ToolCallRecord[] = []
  for (let i = 1; i <= msgCount; i++) {
    const isTool = i % 3 === 0
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
      const role: "user" | "assistant" = i % 2 === 0 ? "assistant" : "user"
      messages.push({ id, role, content, timestamp: `t${i}` })
    }
  }
  return { messages, toolCalls }
}

describe("COE advanced bench", () => {
  const tok = new GPTTokenizer()
  const coe = new COE(tok)

  bench("500 messages with mixed roles", () => {
    const { messages, toolCalls } = makeSessionWithMessages(500, 500)
    const state: SessionState = { ...createSession("b1", "build"), messages, toolCalls }
    coe.optimize(state, { maxContextTokens: 8000 })
  })

  bench("1000 messages with high content size", () => {
    const { messages, toolCalls } = makeSessionWithMessages(1000, 1000)
    const state: SessionState = { ...createSession("b2", "build"), messages, toolCalls }
    coe.optimize(state, { maxContextTokens: 8000 })
  })

  bench("aggressive dedupe (500 dup tool calls)", () => {
    const messages: SessionMessage[] = [
      { id: "sys", role: "system", content: "sys", timestamp: "t0" },
    ]
    const toolCalls: ToolCallRecord[] = []
    for (let i = 0; i < 500; i++) {
      const tcId = `dup-tc`
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
    const state: SessionState = { ...createSession("b3", "build"), messages, toolCalls }
    coe.optimize(state, { maxContextTokens: 8000 })
  })

  bench("very aggressive truncation (maxContextTokens=100)", () => {
    const { messages, toolCalls } = makeSessionWithMessages(200, 2000)
    const state: SessionState = { ...createSession("b4", "build"), messages, toolCalls }
    coe.optimize(state, { maxContextTokens: 100 })
  })

  bench("no-op optimize (session already small)", () => {
    const { messages, toolCalls } = makeSessionWithMessages(5, 50)
    const state: SessionState = { ...createSession("b5", "build"), messages, toolCalls }
    coe.optimize(state, { maxContextTokens: 99999 })
  })
})
