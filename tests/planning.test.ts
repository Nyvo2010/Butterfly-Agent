/**
 * Planning module tests — plan extraction, anchor formatting, auto-completion.
 */
import { describe, expect, it } from "vitest"
import {
  extractPlanFromText,
  formatPlanForPrompt,
  type Plan,
  planProgress,
  updatePlanFromToolResult,
} from "../packages/agent/src/planning"

describe("@butterfly/agent — planning", () => {
  it("extracts a plan from markdown checkboxes", () => {
    const plan = extractPlanFromText("- [ ] read files\n- [x] setup\n- [ ] write code", "goal")
    expect(plan.todos).toHaveLength(3)
    expect(plan.todos[0].completed).toBe(false)
    expect(plan.todos[1].completed).toBe(true)
  })

  it("extracts a plan from numbered lists when no checkboxes", () => {
    const plan = extractPlanFromText("1. step one\n2. step two\n3. step three", "goal")
    expect(plan.todos).toHaveLength(3)
    expect(plan.todos.every((t) => !t.completed)).toBe(true)
  })

  it("formatPlanForPrompt shows ACTIVE PLAN with current-step marker", () => {
    const plan: Plan = {
      goal: "Fix the bug",
      createdAt: new Date().toISOString(),
      todos: [
        { id: "1", task: "read", completed: true, createdAt: new Date().toISOString() },
        { id: "2", task: "fix", completed: false, createdAt: new Date().toISOString() },
        { id: "3", task: "test", completed: false, createdAt: new Date().toISOString() },
      ],
    }
    const out = formatPlanForPrompt(plan)
    expect(out).toContain("ACTIVE PLAN (step 2 of 3)")
    expect(out).toContain("→ 2. fix")
    expect(out).toContain("✓ 1. read")
    expect(out).toContain("Progress: 1/3 complete")
  })

  it("formatPlanForPrompt shows step == total when all done", () => {
    const plan: Plan = {
      goal: "g",
      createdAt: new Date().toISOString(),
      todos: [
        { id: "1", task: "a", completed: true, createdAt: new Date().toISOString() },
        { id: "2", task: "b", completed: true, createdAt: new Date().toISOString() },
      ],
    }
    expect(formatPlanForPrompt(plan)).toContain("ACTIVE PLAN (step 2 of 2)")
  })

  it("formatPlanForPrompt returns empty for empty plan", () => {
    const plan: Plan = { goal: "g", createdAt: new Date().toISOString(), todos: [] }
    expect(formatPlanForPrompt(plan)).toBe("")
  })

  it("updatePlanFromToolResult marks matching path todos complete", () => {
    const plan = extractPlanFromText("- [ ] fix foo.ts", "g")
    const updated = updatePlanFromToolResult(plan, "write", { path: "foo.ts" }, true)
    expect(updated.todos[0].completed).toBe(true)
  })

  it("updatePlanFromToolResult does not complete on failure", () => {
    const plan = extractPlanFromText("- [ ] fix foo.ts", "g")
    const updated = updatePlanFromToolResult(plan, "write", { path: "foo.ts" }, false)
    expect(updated.todos[0].completed).toBe(false)
  })

  it("planProgress counts total/completed/remaining", () => {
    const plan: Plan = {
      goal: "g",
      createdAt: new Date().toISOString(),
      todos: [
        { id: "1", task: "a", completed: true, createdAt: new Date().toISOString() },
        { id: "2", task: "b", completed: false, createdAt: new Date().toISOString() },
        { id: "3", task: "c", completed: false, createdAt: new Date().toISOString() },
      ],
    }
    expect(planProgress(plan)).toEqual({ total: 3, completed: 1, remaining: 2 })
  })
})
