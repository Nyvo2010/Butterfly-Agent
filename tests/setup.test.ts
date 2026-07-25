import { describe, expect, it } from "vitest"

describe("Test infrastructure", () => {
  it("should run basic assertions", () => {
    expect(1 + 1).toBe(2)
  })

  it("should handle async code", async () => {
    const result = await Promise.resolve(42)
    expect(result).toBe(42)
  })
})
