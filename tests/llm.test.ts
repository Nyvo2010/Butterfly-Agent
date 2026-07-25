import { describe, expect, it } from "vitest"
import { ForgivingToolCallParser } from "../packages/llm/src/parser"

describe("@butterfly/llm — ForgivingToolCallParser", () => {
  const parser = new ForgivingToolCallParser()

  it("returns null for empty input", () => {
    expect(parser.parse("")).toBeNull()
    expect(parser.parse("   ")).toBeNull()
  })

  it("parses JSON array of tool calls", () => {
    const result = parser.parse('[{"name":"read","input":{"path":"file.ts"}}]')
    expect(result).toBeTruthy()
    expect(result?.length).toBe(1)
    expect(result?.[0].name).toBe("read")
    expect(result?.[0].input).toEqual({ path: "file.ts" })
  })

  it("parses single JSON object as tool call", () => {
    const result = parser.parse('{"name":"write","input":{"path":"f.ts","content":"x"}}')
    expect(result).toBeTruthy()
    expect(result?.length).toBe(1)
    expect(result?.[0].name).toBe("write")
  })

  it("parses Hermes-style tool call tags", () => {
    const result = parser.parse('<tool_call>{"name":"grep","input":{"pattern":"test"}}</tool_call>')
    expect(result).toBeTruthy()
    expect(result?.length).toBe(1)
    expect(result?.[0].name).toBe("grep")
  })

  it("returns null for unparseable input", () => {
    const result = parser.parse("just some text, no tool calls here")
    expect(result).toBeNull()
  })
})
