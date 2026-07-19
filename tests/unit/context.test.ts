import { mkdtempSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COE, GPTTokenizer, SCE } from "@butterfly/context"
import type { SessionState } from "@butterfly/session"
import { createSession } from "@butterfly/session"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

describe("GPTTokenizer", () => {
  const t = new GPTTokenizer()

  it("counts tokens in text", () => {
    const n = t.count("hello world")
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(10)
  })

  it("counts 0 for empty string", () => {
    expect(t.count("")).toBe(0)
  })

  it("truncates text over max tokens", () => {
    const { text, tokens } = t.truncate("hello world foo bar baz", 2)
    expect(tokens).toBe(2)
    expect(text.length).toBeLessThan("hello world foo bar baz".length)
  })

  it("returns full text when under max tokens", () => {
    const { text, tokens } = t.truncate("hi", 100)
    expect(text).toBe("hi")
    expect(tokens).toBeGreaterThan(0)
  })

  it("returns empty for maxTokens <= 0", () => {
    const { text, tokens } = t.truncate("hello", 0)
    expect(text).toBe("")
    expect(tokens).toBe(0)
  })
})

async function createTestDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sce-test-"))
  await mkdir(join(dir, "src"), { recursive: true })
  await mkdir(join(dir, "lib"), { recursive: true })
  await writeFile(
    join(dir, "src", "math.ts"),
    "export function add(a: number, b: number) { return a + b }\nexport function sub(a: number, b: number) { return a - b }\n",
  )
  await writeFile(
    join(dir, "src", "utils.ts"),
    "export function capitalize(s: string) { return s[0].toUpperCase() + s.slice(1) }\nexport function greet(name: string) { return `Hello ${name}` }\n",
  )
  await writeFile(join(dir, "README.md"), "# Test Project\n\nThis is a test project for SCE.\n")
  return dir
}

describe("SCE", () => {
  let dir: string
  let sce: SCE
  let tok: GPTTokenizer

  beforeEach(async () => {
    tok = new GPTTokenizer()
    sce = new SCE(tok)
    dir = await createTestDir()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("finds grep matches for a query", async () => {
    const slice = await sce.select("add", { cwd: dir })
    expect(slice.grepMatches.length).toBeGreaterThan(0)
    expect(slice.grepMatches.some((m) => m.content.includes("add"))).toBe(true)
  })

  it("returns file snippets for matched files", async () => {
    const slice = await sce.select("capitalize", { cwd: dir })
    expect(slice.fileSnippets.length).toBeGreaterThan(0)
    expect(slice.fileSnippets.some((f) => f.path.endsWith("utils.ts"))).toBe(true)
  })

  it("caches results by query+options", async () => {
    const slice1 = await sce.select("add", { cwd: dir })
    const slice2 = await sce.select("add", { cwd: dir })
    expect(slice1).toBe(slice2)
  })

  it("cache miss on different query", async () => {
    const slice1 = await sce.select("add", { cwd: dir })
    const slice2 = await sce.select("capitalize", { cwd: dir })
    expect(slice1).not.toBe(slice2)
  })

  it("returns empty for non-matching query", async () => {
    const slice = await sce.select("zzzznonexistent", { cwd: dir })
    expect(slice.grepMatches).toHaveLength(0)
    expect(slice.fileSnippets).toHaveLength(0)
  })

  it("respects maxGrepResults option", async () => {
    const slice = await sce.select("export", { cwd: dir, maxGrepResults: 1 })
    expect(slice.grepMatches.length).toBeLessThanOrEqual(1)
  })

  it("respects maxFiles and maxTokensPerFile options", async () => {
    const slice = await sce.select("export", { cwd: dir, maxFiles: 1, maxTokensPerFile: 10 })
    expect(slice.fileSnippets.length).toBeLessThanOrEqual(1)
    for (const f of slice.fileSnippets) {
      expect(f.tokens).toBeLessThanOrEqual(10)
    }
  })

  it("snippet tokens never exceed maxTokensPerFile", async () => {
    const slice = await sce.select("export", { cwd: dir, maxTokensPerFile: 50 })
    for (const f of slice.fileSnippets) {
      expect(f.tokens).toBeLessThanOrEqual(50)
    }
  })

  it("handles empty query gracefully", async () => {
    const slice = await sce.select("", { cwd: dir })
    expect(slice.grepMatches).toHaveLength(0)
  })

  it("SCE outputs ARE sensible: grep matches contain query-relevant content", async () => {
    const slice = await sce.select("capitalize", { cwd: dir })
    expect(slice.grepMatches.length).toBeGreaterThan(0)
    for (const m of slice.grepMatches) {
      expect(m.file).toBeTruthy()
      expect(m.line).toBeGreaterThan(0)
      expect(m.content.length).toBeGreaterThan(0)
    }
  })
})

describe("COE", () => {
  let tok: GPTTokenizer
  let coe: COE

  beforeEach(() => {
    tok = new GPTTokenizer()
    coe = new COE(tok)
  })

  function makeSession(overrides: Partial<SessionState> = {}): SessionState {
    return {
      ...createSession("test-coe", "build"),
      ...overrides,
    }
  }

  it("deduplicates tool calls by id (keeps last)", () => {
    const state = makeSession({
      toolCalls: [
        {
          id: "tc1",
          name: "read",
          input: { path: "a" },
          result: "first",
          startedAt: "t1",
          finishedAt: "t1",
        },
        {
          id: "tc1",
          name: "read",
          input: { path: "b" },
          result: "second",
          startedAt: "t2",
          finishedAt: "t2",
        },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 999999 })
    expect(opt.toolCalls).toHaveLength(1)
    expect(opt.toolCalls[0].result).toBe("second")
  })

  it("truncates long tool messages", () => {
    const state = makeSession({
      messages: [
        { id: "m1", role: "system", content: "system prompt", timestamp: "t0" },
        { id: "m2", role: "user", content: "hi", timestamp: "t1" },
        { id: "m3", role: "tool", content: "x".repeat(5000), toolCallId: "tc1", timestamp: "t2" },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 999999, toolMessageMaxTokens: 100 })
    const toolMsg = opt.messages.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const tokens = tok.count(toolMsg!.content)
    expect(tokens).toBeLessThanOrEqual(100)
  })

  it("drops oldest non-system messages when over token cap", () => {
    const state = makeSession({
      messages: [
        { id: "m1", role: "system", content: "system", timestamp: "t0" },
        {
          id: "m2",
          role: "user",
          content: "first user message that is long enough to exceed the token cap when combined",
          timestamp: "t1",
        },
        { id: "m3", role: "tool", content: "a".repeat(2000), toolCallId: "tc1", timestamp: "t2" },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 20 })
    expect(opt.messages.length).toBeLessThan(state.messages.length)
    expect(opt.messages[0].role).toBe("system")
  })

  it("preserves the system message when dropping", () => {
    const state = makeSession({
      messages: [
        { id: "m1", role: "system", content: "system prompt", timestamp: "t0" },
        { id: "m2", role: "user", content: "a".repeat(1000), timestamp: "t1" },
        { id: "m3", role: "user", content: "b".repeat(1000), timestamp: "t2" },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 50 })
    expect(opt.messages.length).toBeGreaterThanOrEqual(1)
    expect(opt.messages[0]?.role).toBe("system")
  })

  it("handles session with no messages", () => {
    const state = makeSession({ messages: [] })
    const opt = coe.optimize(state, { maxContextTokens: 100 })
    expect(opt.messages).toEqual([])
  })

  it("handles session already under cap", () => {
    const state = makeSession({
      messages: [
        { id: "m1", role: "system", content: "sys", timestamp: "t0" },
        { id: "m2", role: "user", content: "hi", timestamp: "t1" },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 99999 })
    expect(opt.messages).toHaveLength(2)
  })

  it("COE does not mutate the original state", () => {
    const state = makeSession({
      messages: [
        { id: "m1", role: "system", content: "sys", timestamp: "t0" },
        { id: "m2", role: "user", content: "a".repeat(2500), timestamp: "t1" },
        { id: "m3", role: "tool", content: "b".repeat(2500), toolCallId: "tc1", timestamp: "t2" },
      ],
    })
    const originalLen = state.messages.length
    const opt = coe.optimize(state, { maxContextTokens: 10 })
    expect(state.messages).toHaveLength(originalLen)
    expect(opt.messages.length).toBeLessThan(originalLen)
  })

  it("COE does not leave behind important info: system message always survives", () => {
    const state = makeSession({
      messages: [
        {
          id: "m1",
          role: "system",
          content: "You are a Butterfly Agent in BUILD mode. This is the critical system prompt.",
          timestamp: "t0",
        },
        { id: "m2", role: "user", content: "hello world", timestamp: "t1" },
        { id: "m3", role: "tool", content: "a".repeat(3000), toolCallId: "tc1", timestamp: "t2" },
        { id: "m4", role: "user", content: "b".repeat(3000), timestamp: "t3" },
        { id: "m5", role: "tool", content: "c".repeat(3000), toolCallId: "tc2", timestamp: "t4" },
      ],
    })
    const opt = coe.optimize(state, { maxContextTokens: 50 })
    // system message always survives
    const systemMsg = opt.messages.find((m) => m.role === "system")
    expect(systemMsg).toBeDefined()
    expect(systemMsg!.content).toBe(
      "You are a Butterfly Agent in BUILD mode. This is the critical system prompt.",
    )
  })
})
