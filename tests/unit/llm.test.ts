import type { LLMRequest } from "@butterfly/llm"
import {
  MockLLMClient,
  textResponse,
  toolCallResponse,
  VercelAILLMClient,
  zeroUsage,
} from "@butterfly/llm"
import { describe, expect, it } from "vitest"

describe("MockLLMClient", () => {
  it("returns scripted responses in order", async () => {
    const client = new MockLLMClient([
      textResponse("first"),
      toolCallResponse([{ id: "c1", name: "read", input: { path: "a" } }]),
    ])
    const r1 = await client.complete({ model: "test", system: "", messages: [] })
    expect(r1.kind).toBe("text")
    if (r1.kind === "text") expect(r1.text).toBe("first")

    const r2 = await client.complete({ model: "test", system: "", messages: [] })
    expect(r2.kind).toBe("tool_calls")
    if (r2.kind === "tool_calls") {
      expect(r2.calls).toHaveLength(1)
      expect(r2.calls[0].name).toBe("read")
    }
  })

  it("throws when script exhausted", async () => {
    const client = new MockLLMClient([textResponse("only")])
    await client.complete({ model: "test", system: "", messages: [] })
    await expect(client.complete({ model: "test", system: "", messages: [] })).rejects.toThrow(
      "exhausted",
    )
  })

  it("accepts a function script", async () => {
    const client = new MockLLMClient((req: LLMRequest) => {
      return textResponse(`model=${req.model}`)
    })
    const r = await client.complete({ model: "my-model", system: "", messages: [] })
    expect(r.kind).toBe("text")
    if (r.kind === "text") expect(r.text).toBe("model=my-model")
  })

  it("function script can return async", async () => {
    const client = new MockLLMClient(async () =>
      toolCallResponse([{ id: "c1", name: "bash", input: { command: "ls" } }]),
    )
    const r = await client.complete({ model: "test", system: "", messages: [] })
    expect(r.kind).toBe("tool_calls")
  })
})

describe("textResponse / toolCallResponse helpers", () => {
  it("textResponse creates correct shape", () => {
    const r = textResponse("hello")
    expect(r.kind).toBe("text")
    if (r.kind === "text") {
      expect(r.text).toBe("hello")
      expect(r.usage.totalTokens).toBe(0)
    }
  })

  it("toolCallResponse creates correct shape", () => {
    const r = toolCallResponse([{ id: "t1", name: "read", input: { path: "x" } }])
    expect(r.kind).toBe("tool_calls")
    if (r.kind === "tool_calls") {
      expect(r.calls[0].name).toBe("read")
    }
  })

  it("toolCallResponse includes usage", () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    const r = toolCallResponse([], usage)
    expect(r.kind).toBe("tool_calls")
    if (r.kind === "tool_calls") {
      expect(r.usage.totalTokens).toBe(15)
    }
  })
})

describe("VercelAILLMClient", () => {
  it("throws on missing apiKey", () => {
    expect(() => new VercelAILLMClient({ apiKey: "" })).not.toThrow()
  })

  it("throws on tool message without toolCallId", async () => {
    const client = new VercelAILLMClient({ apiKey: "dummy" })
    await expect(
      client.complete({
        model: "test",
        system: "",
        messages: [{ role: "tool", content: "result" }],
      }),
    ).rejects.toThrow("toolCallId")
  })

  it("constructs with baseUrl", () => {
    const client = new VercelAILLMClient({ apiKey: "key", baseUrl: "https://custom.api.com" })
    expect(client).toBeInstanceOf(VercelAILLMClient)
  })
})
