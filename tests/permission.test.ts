/**
 * Permission hook tests — wildcard patterns + per-session approved rules.
 */
import { describe, expect, it } from "vitest"
import {
  buildPermissionHook,
  matchesPattern,
  patternToRegExp,
} from "../packages/agent/src/permission"

describe("@butterfly/agent — permission patterns", () => {
  it("matchesPattern handles glob wildcards", () => {
    expect(matchesPattern("git *", "git status")).toBe(true)
    expect(matchesPattern("git *", "npm test")).toBe(false)
    expect(matchesPattern("npm run *", "npm run build")).toBe(true)
    expect(matchesPattern("*", "anything at all")).toBe(true)
    expect(matchesPattern("exact", "exact")).toBe(true)
    expect(matchesPattern("exact", "not exact")).toBe(false)
  })

  it("patternToRegExp escapes regex metachars", () => {
    expect(patternToRegExp("a+b").test("a+b")).toBe(true)
    expect(patternToRegExp("a+b").test("aaab")).toBe(false)
  })

  it("no config = allow all", async () => {
    const hook = buildPermissionHook(undefined, undefined)
    expect(await hook("write", { path: "x" })).toEqual({ allowed: true })
  })

  it("edit deny blocks writes", async () => {
    const hook = buildPermissionHook({ edit: "deny" }, undefined)
    const r = await hook("write", { path: "x" })
    expect(r.allowed).toBe(false)
  })

  it("bash wildcard rules apply", async () => {
    const hook = buildPermissionHook({ bash: { "git *": "deny" } }, undefined)
    const denied = await hook("bash", { command: "git push" })
    expect(denied.allowed).toBe(false)
    const allowed = await hook("bash", { command: "npm test" })
    expect(allowed.allowed).toBe(true)
  })

  it("ask flow with 'always' remembers per-session approval", async () => {
    const answers: string[] = ["always"]
    const hook = buildPermissionHook({ edit: "ask" }, async () => answers.shift() ?? "no")
    // First call asks → "always" → remembered.
    const first = await hook("write", { path: "foo.ts" }, "session-1")
    expect(first.allowed).toBe(true)
    // Second call same session + same path → no ask.
    const second = await hook("write", { path: "foo.ts" }, "session-1")
    expect(second.allowed).toBe(true)
    // Different session → asks again.
    const other = await hook("write", { path: "foo.ts" }, "session-2")
    expect(other.allowed).toBe(false) // answers exhausted → "no"
  })
})
