/**
 * Loop detector unit tests — repeat/no-progress/wandering detection.
 */
import { describe, expect, it } from "vitest"
import { argsHash, ToolLoopTracker } from "../packages/agent/src/loop-detector"

describe("@butterfly/agent — ToolLoopTracker", () => {
  it("check returns ok for a fresh call", () => {
    const t = new ToolLoopTracker()
    expect(t.check("read", { path: "a.ts" }).level).toBe("ok")
  })

  it("detects generic_repeat after warningThreshold identical calls", () => {
    const t = new ToolLoopTracker({ warningThreshold: 3 })
    t.record("read", { path: "a.ts" }, true)
    t.record("read", { path: "a.ts" }, true)
    // Third identical call (2 recorded + this) → warn.
    const verdict = t.check("read", { path: "a.ts" })
    expect(verdict.level).toBe("warn")
    expect(verdict.detector).toBe("generic_repeat")
  })

  it("detects no_progress veto after criticalThreshold failing repeats", () => {
    const t = new ToolLoopTracker({ criticalThreshold: 3 })
    t.record("bash", { command: "npm test" }, false)
    t.record("bash", { command: "npm test" }, false)
    const verdict = t.check("bash", { command: "npm test" })
    expect(verdict.level).toBe("critical")
    expect(verdict.detector).toBe("no_progress")
  })

  it("a success resets the no-progress streak", () => {
    const t = new ToolLoopTracker({ criticalThreshold: 3 })
    t.record("bash", { command: "npm test" }, false)
    t.record("bash", { command: "npm test" }, false)
    t.record("bash", { command: "npm test" }, true) // success resets
    const verdict = t.check("bash", { command: "npm test" })
    expect(verdict.level).not.toBe("critical")
  })

  it("detects wandering on search-like tools with many distinct args", () => {
    const t = new ToolLoopTracker({ wanderingThreshold: 3, wanderingEscalation: 5 })
    t.record("search", { query: "aaa" }, true)
    t.record("search", { query: "bbb" }, true)
    const verdict = t.check("search", { query: "ccc" })
    expect(verdict.level).toBe("warn")
    expect(verdict.detector).toBe("wandering")
  })

  it("wandering escalates to critical at wanderingEscalation", () => {
    const t = new ToolLoopTracker({ wanderingThreshold: 2, wanderingEscalation: 3 })
    t.record("search", { query: "aaa" }, true)
    t.record("search", { query: "bbb" }, true)
    const verdict = t.check("search", { query: "ccc" })
    expect(verdict.level).toBe("critical")
    expect(verdict.detector).toBe("wandering")
  })

  it("registerVeto trips the breaker after breakerVetoStreak vetoes", () => {
    const t = new ToolLoopTracker({ breakerVetoStreak: 2 })
    const v1 = t.check("bash", { command: "x" })
    // Force a critical verdict to test the breaker.
    t.record("bash", { command: "x" }, false)
    t.record("bash", { command: "x" }, false)
    const veto = t.check("bash", { command: "x" })
    expect(t.registerVeto(veto)).toBe(false)
    expect(t.registerVeto(veto)).toBe(true)
    expect(v1).toBeTruthy()
  })

  it("noticeFor returns null for ok and text for warn/critical", () => {
    const t = new ToolLoopTracker()
    t.record("read", { path: "a.ts" }, true)
    t.record("read", { path: "a.ts" }, true)
    const warn = t.check("read", { path: "a.ts" })
    expect(t.noticeFor(warn)).toBeTruthy()
    expect(
      t.noticeFor({ level: "ok", detector: "generic_repeat", count: 0, warningKey: "", tool: "" }),
    ).toBeNull()
  })

  it("argsHash is stable for equal inputs and distinct for different", () => {
    expect(argsHash({ a: 1 })).toBe(argsHash({ a: 1 }))
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }))
  })
})
