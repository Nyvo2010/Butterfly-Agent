/**
 * LLM failure classification tests — retryable categories, status fast-path.
 */
import { describe, expect, it } from "vitest"
import { classifyFailure, isRetryable } from "../packages/llm/src/failure"

describe("@butterfly/llm — classifyFailure", () => {
  it("classifies rate limits as retryable", () => {
    const f = classifyFailure(new Error("429 Too Many Requests"))
    expect(f.category).toBe("rate_limit")
    expect(f.retryable).toBe(true)
    expect(isRetryable(f)).toBe(true)
  })

  it("classifies status 429 via numeric status", () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 })
    expect(classifyFailure(err).category).toBe("rate_limit")
  })

  it("classifies auth errors as non-retryable", () => {
    const f = classifyFailure(new Error("401 Unauthorized: invalid API key"))
    expect(f.category).toBe("auth")
    expect(f.retryable).toBe(false)
  })

  it("classifies timeouts as retryable", () => {
    const f = classifyFailure(new Error("ESOCKETTIMEDOUT"))
    expect(f.category).toBe("timeout")
    expect(f.retryable).toBe(true)
  })

  it("classifies 5xx server errors as retryable", () => {
    const err = Object.assign(new Error("boom"), { status: 503 })
    const f = classifyFailure(err)
    expect(f.category).toBe("server_error")
    expect(f.retryable).toBe(true)
  })

  it("classifies context overflow", () => {
    const f = classifyFailure(new Error("maximum context length exceeded"))
    expect(f.category).toBe("context_overflow")
    expect(f.retryable).toBe(false)
  })

  it("classifies model-not-found", () => {
    const f = classifyFailure(new Error("model not found: gpt-5"))
    expect(f.category).toBe("model_not_found")
  })

  it("classifies network errors as retryable", () => {
    const f = classifyFailure(new Error("ECONNREFUSED"))
    expect(f.category).toBe("network")
    expect(f.retryable).toBe(true)
  })

  it("falls back to unknown for unmatched errors", () => {
    const f = classifyFailure(new Error("something totally unexpected happened here"))
    expect(f.category).toBe("unknown")
    expect(f.retryable).toBe(false)
  })
})
