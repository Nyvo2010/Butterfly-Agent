import { describe, expect, it } from "vitest"
import { GPTTokenizer } from "../packages/context/src/tokenizer"

describe("@butterfly/context — GPTTokenizer", () => {
  const tokenizer = new GPTTokenizer()

  it("warmup completes without error", () => {
    tokenizer.warmup()
  })

  it("count returns a positive number for non-empty text", () => {
    const result = tokenizer.count("Hello, world!")
    expect(result).toBeGreaterThan(0)
  })

  it("count returns 0 for empty string", () => {
    expect(tokenizer.count("")).toBe(0)
  })

  it("truncate returns text within budget", () => {
    const result = tokenizer.truncate("hello world", 5)
    expect(result.tokens).toBeLessThanOrEqual(5)
    expect(result.text.length).toBeGreaterThan(0)
  })
})
