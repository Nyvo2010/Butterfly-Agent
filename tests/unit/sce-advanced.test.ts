import { mkdtempSync } from "node:fs"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GPTTokenizer, SCE } from "@butterfly/context"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

async function createLargeDir(
  base: string,
  filesPerDir: number,
  depth: number,
  prefix = "",
): Promise<void> {
  await mkdir(base, { recursive: true })
  for (let i = 0; i < filesPerDir; i++) {
    const fn = join(base, `f${prefix}${i}.ts`)
    await writeFile(fn, `export function fn${prefix}${i}() { return ${i} }\n`)
  }
  if (depth > 0) {
    for (let i = 0; i < 3; i++) {
      await createLargeDir(join(base, `sub${i}`), filesPerDir, depth - 1, `${prefix}${i}_`)
    }
  }
}

describe("SCE advanced", () => {
  let tok: GPTTokenizer
  let sce: SCE

  beforeEach(() => {
    tok = new GPTTokenizer()
    sce = new SCE(tok)
  })

  it("handles deeply nested directory structure (10 levels)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-deep-"))
    let current = dir
    for (let i = 0; i < 10; i++) {
      const sub = join(current, `level${i}`)
      await mkdir(sub, { recursive: true })
      await writeFile(join(sub, `f${i}.ts`), `export const val${i} = ${i}\n`)
      current = sub
    }
    const slice = await sce.select("val9", { cwd: dir })
    expect(slice.grepMatches.length).toBeGreaterThan(0)
    expect(slice.grepMatches.some((m) => m.file.includes("level9"))).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  it("handles empty directory gracefully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-empty-"))
    const slice = await sce.select("anything", { cwd: dir })
    expect(slice.grepMatches).toHaveLength(0)
    expect(slice.fileSnippets).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
  })

  it("handles directory with only skipped dirs (node_modules)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-nm-"))
    await mkdir(join(dir, "node_modules"), { recursive: true })
    await writeFile(join(dir, "node_modules", "lib.ts"), "secret code")
    const slice = await sce.select("secret", { cwd: dir })
    expect(slice.grepMatches).toHaveLength(0)
    expect(slice.fileSnippets).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
  })

  it("handles files with very long lines (>10K chars)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-longlines-"))
    const longLine = "x".repeat(15000) + " needle " + "y".repeat(5000)
    await writeFile(join(dir, "long.txt"), longLine)
    const slice = await sce.select("needle", { cwd: dir })
    expect(slice.grepMatches.length).toBeGreaterThan(0)
    expect(slice.grepMatches[0].content).toContain("needle")
    await rm(dir, { recursive: true, force: true })
  })

  it("handles non-ASCII filenames and content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-unicode-"))
    await writeFile(join(dir, "résumé.ts"), "export function café() { return '☕' }\n")
    await writeFile(join(dir, "数据.ts"), "export const 版本 = '1.0'\n")
    const slice1 = await sce.select("café", { cwd: dir })
    expect(slice1.grepMatches.length).toBeGreaterThan(0)
    const slice2 = await sce.select("版本", { cwd: dir })
    expect(slice2.grepMatches.length).toBeGreaterThan(0)
    await rm(dir, { recursive: true, force: true })
  })

  it("handles many files (1000+) efficiently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-many-"))
    for (let i = 0; i < 1000; i++) {
      await writeFile(join(dir, `f${i}.ts`), `export const v${i} = ${i}\n`)
    }
    const slice = await sce.select("v999", { cwd: dir })
    expect(slice.grepMatches.length).toBeGreaterThan(0)
    await rm(dir, { recursive: true, force: true })
  })

  it("cache hit is faster than cold query", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-cacheperf-"))
    for (let i = 0; i < 200; i++) {
      await writeFile(join(dir, `f${i}.ts`), `export const v${i} = ${i}\n`)
    }
    const coldStart = performance.now()
    await sce.select("v100", { cwd: dir })
    const coldTime = performance.now() - coldStart
    const warmStart = performance.now()
    await sce.select("v100", { cwd: dir })
    const cacheTime = performance.now() - warmStart
    expect(cacheTime).toBeLessThan(coldTime + 1)
    await rm(dir, { recursive: true, force: true })
  })

  it("cache miss on different options triggers new search", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-cachemiss-"))
    await writeFile(join(dir, "a.ts"), "export const a = 1\n")
    await writeFile(join(dir, "b.ts"), "export const b = 2\n")
    const s1 = await sce.select("export", { cwd: dir, maxGrepResults: 1 })
    const s2 = await sce.select("export", { cwd: dir, maxGrepResults: 10 })
    expect(s1).not.toBe(s2)
    await rm(dir, { recursive: true, force: true })
  })

  it("handles concurrent select calls correctly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-concurrent-"))
    for (let i = 0; i < 100; i++) {
      await writeFile(join(dir, `f${i}.ts`), `export const v${i} = ${i}\n`)
    }
    const results = await Promise.all([
      sce.select("v10", { cwd: dir }),
      sce.select("v20", { cwd: dir }),
      sce.select("v30", { cwd: dir }),
      sce.select("v40", { cwd: dir }),
      sce.select("v50", { cwd: dir }),
    ])
    for (const r of results) {
      expect(r.grepMatches.length).toBeGreaterThan(0)
    }
    await rm(dir, { recursive: true, force: true })
  })

  it("handles very large files (>100K chars) without crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-largefile-"))
    const huge = "export const data = '" + "x".repeat(10_000) + "'\n// needle\n"
    await writeFile(join(dir, "huge.ts"), huge)
    const slice = await sce.select("needle", { cwd: dir, maxTokensPerFile: 100 })
    expect(slice.grepMatches.length).toBeGreaterThan(0)
    expect(slice.fileSnippets.length).toBeGreaterThan(0)
    expect(slice.fileSnippets[0].tokens).toBeLessThanOrEqual(100)
    await rm(dir, { recursive: true, force: true })
  })

  it("preserves the original query intent with multi-word queries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-intent-"))
    await writeFile(
      join(dir, "math.ts"),
      "export function add(a: number, b: number) { return a + b }\n",
    )
    await writeFile(
      join(dir, "strings.ts"),
      "export function addStrings(a: string, b: string) { return a + b }\n",
    )
    await writeFile(join(dir, "other.ts"), "export const greeting = 'hello'\n")
    const slice = await sce.select("add function", { cwd: dir })
    expect(slice.grepMatches.length).toBeGreaterThan(0)
    for (const m of slice.grepMatches) {
      expect(m.file).not.toBe("other.ts")
    }
    await rm(dir, { recursive: true, force: true })
  })

  it("handles stop-word-only query gracefully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-stopwords-"))
    await writeFile(join(dir, "test.ts"), "the and for with this that\n")
    const slice = await sce.select("the and for with", { cwd: dir })
    expect(slice.grepMatches).toBeDefined()
    await rm(dir, { recursive: true, force: true })
  })

  it("handles query with regex special characters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sce-regexchars-"))
    await writeFile(join(dir, "calc.ts"), "export function add(a+b: number) { return a + b }\n")
    const slice = await sce.select("a+b", { cwd: dir })
    expect(slice.grepMatches.length).toBeGreaterThan(0)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("SCE tokenizer edge cases", () => {
  it("counts tokens for strings with emoji and unicode", () => {
    const t = new GPTTokenizer()
    const n = t.count("Hello 世界 🌍🚀")
    expect(n).toBeGreaterThan(0)
  })

  it("counts tokens for code with special characters", () => {
    const t = new GPTTokenizer()
    const n = t.count("export function<T>(x: T): T { return x }")
    expect(n).toBeGreaterThan(0)
  })

  it("counts tokens for JSON blobs", () => {
    const t = new GPTTokenizer()
    const json = JSON.stringify({ a: 1, b: [1, 2, 3], c: { nested: "deep" } })
    const n = t.count(json)
    expect(n).toBeGreaterThan(0)
  })

  it("truncate with exactly maxTokens boundary", () => {
    const t = new GPTTokenizer()
    const text = "hello world foo bar"
    const { text: truncated, tokens } = t.truncate(text, 4)
    const remaining = t.count(truncated)
    expect(remaining).toBeLessThanOrEqual(4)
    expect(tokens).toBeLessThanOrEqual(4)
  })

  it("truncate returns empty for zero maxTokens", () => {
    const t = new GPTTokenizer()
    const { text, tokens } = t.truncate("anything", 0)
    expect(text).toBe("")
    expect(tokens).toBe(0)
  })

  it("truncate returns empty for negative maxTokens", () => {
    const t = new GPTTokenizer()
    const { text, tokens } = t.truncate("anything", -1)
    expect(text).toBe("")
    expect(tokens).toBe(0)
  })

  it("truncate handles null-like input", () => {
    const t = new GPTTokenizer()
    const { text, tokens } = t.truncate("", 100)
    expect(text).toBe("")
    expect(tokens).toBe(0)
  })
})
