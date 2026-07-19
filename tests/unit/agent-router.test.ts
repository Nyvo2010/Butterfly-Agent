import { ModelRouter } from "@butterfly/agent"
import { afterEach, describe, expect, it } from "vitest"

describe("ModelRouter advanced", () => {
  afterEach(() => {
    delete process.env.BUTTERFLY_MODEL_TRIVIAL
    delete process.env.BUTTERFLY_MODEL_STANDARD
    delete process.env.BUTTERFLY_MODEL_COMPLEX
    delete process.env.BUTTERFLY_MODEL_ESCALATE
  })

  it("reads all 4 env overrides at construction", () => {
    process.env.BUTTERFLY_MODEL_TRIVIAL = "env-trivial"
    process.env.BUTTERFLY_MODEL_STANDARD = "env-standard"
    process.env.BUTTERFLY_MODEL_COMPLEX = "env-complex"
    process.env.BUTTERFLY_MODEL_ESCALATE = "env-escalate"
    const router = new ModelRouter()
    expect(router.resolve("trivial", 0).model).toBe("env-trivial")
    expect(router.resolve("standard", 0).model).toBe("env-standard")
    expect(router.resolve("complex", 0).model).toBe("env-complex")
    expect(router.resolve("escalate", 0).model).toBe("env-escalate")
  })

  it("falls back to defaults when env vars not set", () => {
    delete process.env.BUTTERFLY_MODEL_TRIVIAL
    delete process.env.BUTTERFLY_MODEL_STANDARD
    delete process.env.BUTTERFLY_MODEL_COMPLEX
    delete process.env.BUTTERFLY_MODEL_ESCALATE
    const router = new ModelRouter()
    expect(router.resolve("trivial", 0).model).toBeTruthy()
    expect(router.resolve("standard", 0).model).toBeTruthy()
  })

  it("custom tier mapping overrides defaults", () => {
    const router = new ModelRouter({
      tierMapping: {
        trivial: "custom-trivial",
        standard: "custom-standard",
        complex: "custom-complex",
        escalate: "custom-escalate",
      },
    })
    expect(router.resolve("trivial", 0).model).toBe("custom-trivial")
    expect(router.resolve("escalate", 0).model).toBe("custom-escalate")
  })

  it("custom tier mapping with missing key falls back", () => {
    // When partial tierMapping is given, all fields must be present
    const router = new ModelRouter({
      tierMapping: {
        trivial: "custom-t",
        standard: "custom-s",
        complex: "custom-c",
        escalate: "custom-e",
      },
    })
    expect(router.resolve("trivial", 0).model).toBe("custom-t")
  })

  it("escalationLimit 0 prevents any escalation", () => {
    const router = new ModelRouter({ escalationLimit: 0 })
    const e = router.escalate("trivial", 0)
    expect(e.capped).toBe(true)
    expect(e.tier).toBe("trivial")
  })

  it("escalationLimit 1 allows single escalation", () => {
    const router = new ModelRouter({ escalationLimit: 1 })
    const e1 = router.escalate("trivial", 0)
    expect(e1.capped).toBe(false)
    expect(e1.tier).toBe("standard")
    const e2 = router.escalate("standard", 1)
    expect(e2.capped).toBe(true)
    expect(e2.tier).toBe("standard")
  })

  it("escalation from complex with max depth returns capped", () => {
    const router = new ModelRouter()
    const e = router.escalate("complex", 3)
    expect(e.capped).toBe(true)
    expect(e.tier).toBe("complex")
  })

  it("escalate handles all 4 tier transitions correctly", () => {
    const router = new ModelRouter({ escalationLimit: 10 })
    const cases = [
      { from: "trivial" as const, depth: 0, expected: "standard" as const },
      { from: "standard" as const, depth: 1, expected: "complex" as const },
      { from: "complex" as const, depth: 2, expected: "escalate" as const },
      { from: "escalate" as const, depth: 3, expected: "escalate" as const },
    ]
    for (const { from, depth, expected } of cases) {
      const e = router.escalate(from, depth)
      expect(e.tier).toBe(expected)
    }
  })

  it("resolve with depth 0 through 3 returns correct escalationDepth", () => {
    const router = new ModelRouter()
    const r0 = router.resolve("trivial", 0)
    expect(r0.escalationDepth).toBe(0)
    const r1 = router.resolve("standard", 1)
    expect(r1.escalationDepth).toBe(1)
    const r2 = router.resolve("complex", 2)
    expect(r2.escalationDepth).toBe(2)
    const r3 = router.resolve("escalate", 3)
    expect(r3.escalationDepth).toBe(3)
  })

  it("tierMapping argument takes priority when provided (env ignored)", () => {
    process.env.BUTTERFLY_MODEL_TRIVIAL = "env-ignored"
    const router = new ModelRouter({
      tierMapping: {
        trivial: "arg-wins",
        standard: "default-s",
        complex: "default-c",
        escalate: "default-e",
      },
    })
    expect(router.resolve("trivial", 0).model).toBe("arg-wins")
  })
})
