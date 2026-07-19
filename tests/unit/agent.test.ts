import { buildSystemPrompt, kindsForMode, ModelRouter, modePolicyText } from "@butterfly/agent"
import type { ContextSlice } from "@butterfly/context"
import { bashTool, readTool, ToolRegistry, writeTool } from "@butterfly/tools"
import { describe, expect, it } from "vitest"

describe("ModelRouter", () => {
  it("resolves trivial tier to model", () => {
    const router = new ModelRouter()
    const r = router.resolve("trivial", 0)
    expect(r.tier).toBe("trivial")
    expect(r.model).toBeTruthy()
    expect(typeof r.model).toBe("string")
  })

  it("resolves standard tier", () => {
    const router = new ModelRouter()
    const r = router.resolve("standard", 0)
    expect(r.tier).toBe("standard")
  })

  it("resolves escalate tier", () => {
    const router = new ModelRouter()
    const r = router.resolve("escalate", 3)
    expect(r.tier).toBe("escalate")
  })

  it("escalates from trivial to standard", () => {
    const router = new ModelRouter()
    const e = router.escalate("trivial", 0)
    expect(e.tier).toBe("standard")
    expect(e.capped).toBe(false)
  })

  it("escalates from standard to complex", () => {
    const router = new ModelRouter()
    const e = router.escalate("standard", 1)
    expect(e.tier).toBe("complex")
    expect(e.capped).toBe(false)
  })

  it("caps escalation at complex when depth >= 2", () => {
    // default escalationLimit is 2; depth 2 is already capped
    const router = new ModelRouter()
    const e = router.escalate("complex", 2)
    expect(e.tier).toBe("complex")
    expect(e.capped).toBe(true)
  })

  it("custom escalation limit", () => {
    const router = new ModelRouter({ escalationLimit: 3 })
    const e1 = router.escalate("trivial", 0)
    expect(e1.capped).toBe(false)
    expect(e1.tier).toBe("standard")
    const e2 = router.escalate("standard", 1)
    expect(e2.capped).toBe(false)
    expect(e2.tier).toBe("complex")
    const e3 = router.escalate("complex", 2)
    expect(e3.capped).toBe(false)
    expect(e3.tier).toBe("escalate")
    const e4 = router.escalate("escalate", 3)
    expect(e4.capped).toBe(true)
    expect(e4.tier).toBe("escalate")
  })

  it("escalation from escalate returns same tier capped", () => {
    const router = new ModelRouter()
    const e = router.escalate("escalate", 3)
    expect(e.tier).toBe("escalate")
    expect(e.capped).toBe(true)
  })

  it("reads env overrides at construction", () => {
    process.env.BUTTERFLY_MODEL_TRIVIAL = "env-test-model"
    const router = new ModelRouter()
    const r = router.resolve("trivial", 0)
    expect(r.model).toBe("env-test-model")
    delete process.env.BUTTERFLY_MODEL_TRIVIAL
  })
})

describe("Modes", () => {
  it("kindsForMode returns read-only for plan", () => {
    const kinds = kindsForMode("plan")
    expect(kinds).toEqual(["read"])
  })

  it("kindsForMode returns full access for build", () => {
    const kinds = kindsForMode("build")
    expect(kinds.sort()).toEqual(["exec", "read", "write"].sort())
  })

  it("kindsForMode returns read+delegate for orchestrator", () => {
    const kinds = kindsForMode("orchestrator")
    expect(kinds).toEqual(["read", "delegate"])
  })

  it("modePolicyText describes plan mode correctly", () => {
    const text = modePolicyText("plan")
    expect(text).toContain("read-only")
  })

  it("modePolicyText describes build mode correctly", () => {
    const text = modePolicyText("build")
    expect(text).toContain("full tool access")
  })

  it("modePolicyText describes orchestrator mode correctly", () => {
    const text = modePolicyText("orchestrator")
    expect(text).toContain("read-only")
  })
})

describe("Prompt builder", () => {
  const emptySlice: ContextSlice = { grepMatches: [], fileSnippets: [] }
  const sampleSlice: ContextSlice = {
    grepMatches: [{ file: "src/math.ts", line: 1, content: "export function add" }],
    fileSnippets: [
      {
        path: "src/math.ts",
        content: "export function add(a: number, b: number) { return a + b }",
        tokens: 15,
      },
    ],
  }

  it("builds system prompt with mode and tools", () => {
    const prompt = buildSystemPrompt({
      mode: "build",
      query: "add a function",
      sceSlice: emptySlice,
      tools: [readTool, writeTool],
    })
    expect(prompt.system).toContain("BUILD")
    expect(prompt.system).toContain("read")
    expect(prompt.system).toContain("write")
    expect(prompt.system).toContain("add a function")
  })

  it("includes grep matches in prompt", () => {
    const prompt = buildSystemPrompt({
      mode: "plan",
      query: "find exports",
      sceSlice: sampleSlice,
      tools: [readTool],
    })
    expect(prompt.grepMatches).toContain("src/math.ts:1")
    expect(prompt.codeContext).toContain("src/math.ts")
  })

  it("handles no tools available", () => {
    const prompt = buildSystemPrompt({
      mode: "plan",
      query: "test",
      sceSlice: emptySlice,
      tools: [],
    })
    expect(prompt.system).toContain("no tools")
  })

  it("handles empty grep results", () => {
    const prompt = buildSystemPrompt({
      mode: "build",
      query: "test",
      sceSlice: emptySlice,
      tools: [readTool],
    })
    expect(prompt.grepMatches).toContain("none")
    expect(prompt.codeContext).toContain("no file snippets")
  })
})
