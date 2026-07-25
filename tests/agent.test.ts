import { describe, expect, it } from "vitest"
import { kindsForMode, modePolicyText } from "../packages/agent/src/modes"
import { buildSystemPrompt } from "../packages/agent/src/prompt"
import { ModelRouter } from "../packages/agent/src/router"
import type { Mode } from "../packages/session/src/types"

describe("@butterfly/agent — modes", () => {
  it("plan mode only allows read tools", () => {
    const kinds = kindsForMode("plan")
    expect(kinds).toEqual(["read"])
  })

  it("build mode allows read, write, exec, delegate", () => {
    const kinds = kindsForMode("build")
    expect(kinds).toContain("read")
    expect(kinds).toContain("write")
    expect(kinds).toContain("exec")
    expect(kinds).toContain("delegate")
  })

  it("modePolicyText returns non-empty strings", () => {
    for (const mode of ["plan", "build"] as Mode[]) {
      expect(modePolicyText(mode).length).toBeGreaterThan(0)
    }
  })
})

describe("@butterfly/agent — ModelRouter", () => {
  const tierMapping = {
    trivial: "model-trivial",
    standard: "model-standard",
    complex: "model-complex",
    escalate: "model-escalate",
  }

  it("resolve returns the correct model per tier", () => {
    const router = new ModelRouter({ tierMapping })
    expect(router.resolve("trivial", 0).model).toBe("model-trivial")
    expect(router.resolve("standard", 0).model).toBe("model-standard")
    expect(router.resolve("complex", 0).model).toBe("model-complex")
    expect(router.resolve("escalate", 0).model).toBe("model-escalate")
  })

  it("escalate advances through tiers", () => {
    const router = new ModelRouter({ tierMapping, escalationLimit: 3 })
    const r1 = router.escalate("trivial", 0)
    expect(r1.tier).toBe("standard")
    expect(r1.capped).toBe(false)

    const r2 = router.escalate("standard", 1)
    expect(r2.tier).toBe("complex")
    expect(r2.capped).toBe(false)

    const r3 = router.escalate("complex", 2)
    expect(r3.tier).toBe("escalate")
    expect(r3.capped).toBe(false)

    const r4 = router.escalate("escalate", 3)
    expect(r4.capped).toBe(true)
  })

  it("escalate caps at escalation limit", () => {
    const router = new ModelRouter({ tierMapping, escalationLimit: 1 })
    const r = router.escalate("trivial", 1)
    expect(r.capped).toBe(true)
  })
})

describe("@butterfly/agent — buildSystemPrompt", () => {
  it("builds prompt for build mode with tools", () => {
    const result = buildSystemPrompt({
      mode: "build",
      query: "Fix the bug in foo.ts",
      sceSlice: {
        grepMatches: [{ file: "foo.ts", line: 10, content: "const x = 1" }],
        fileSnippets: [{ path: "foo.ts", content: "export function foo() {}", tokens: 20 }],
        warnings: [],
      },
      tools: [{ name: "read", kind: "read", description: "Reads a file" }],
    })
    expect(result.system).toContain("BUILD mode")
    expect(result.system).toContain("Fix the bug in foo.ts")
    expect(result.system).toContain("read")
    expect(result.toolList).toContain("read")
  })

  it("handles empty tools gracefully", () => {
    const result = buildSystemPrompt({
      mode: "plan",
      query: "test",
      sceSlice: { grepMatches: [], fileSnippets: [], warnings: [] },
      tools: [],
    })
    expect(result.toolList).toContain("no tools available")
  })
})
