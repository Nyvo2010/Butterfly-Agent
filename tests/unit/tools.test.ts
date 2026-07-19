import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bashTool,
  globTool,
  grepTool,
  listTool,
  patchTool,
  readTool,
  ToolRegistry,
  writeTool,
} from "@butterfly/tools"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

async function tmpDir(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), "tools-test-"))
  await mkdir(join(d, "sub"), { recursive: true })
  await writeFile(join(d, "hello.txt"), "hello world\nline two\n")
  await writeFile(join(d, "sub", "nested.txt"), "nested content\n")
  return d
}

describe("ToolRegistry", () => {
  it("registers and retrieves tools", () => {
    const r = new ToolRegistry()
    r.register(readTool)
    expect(r.get("read")).toBe(readTool)
    expect(r.has("read")).toBe(true)
    expect(r.has("nonexistent")).toBe(false)
  })

  it("rejects duplicate registration", () => {
    const r = new ToolRegistry()
    r.register(readTool)
    expect(() => r.register(readTool)).toThrow("duplicate")
  })

  it("lists all tools", () => {
    const r = new ToolRegistry()
    r.register(readTool)
    r.register(writeTool)
    expect(r.list()).toHaveLength(2)
    expect(r.size()).toBe(2)
  })

  it("listAllowed filters by kind", () => {
    const r = new ToolRegistry()
    r.register(readTool)
    r.register(writeTool)
    r.register(bashTool)
    const reads = r.listAllowed(["read"])
    expect(reads).toHaveLength(1)
    expect(reads[0].name).toBe("read")
    const writes = r.listAllowed(["write"])
    expect(writes).toHaveLength(1)
    expect(writes[0].name).toBe("write")
    const all = r.listAllowed(["read", "write", "exec"])
    expect(all).toHaveLength(3)
  })
})

describe("read tool", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reads an existing file", async () => {
    const result = await readTool.execute({ path: "hello.txt" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.content).toContain("hello world")
      expect(result.output.size).toBeGreaterThan(0)
    }
  })

  it("returns error for non-existent file", async () => {
    const result = await readTool.execute({ path: "nope.txt" }, { cwd: dir })
    expect(result.kind).toBe("err")
  })

  it("returns error for directory", async () => {
    const result = await readTool.execute({ path: "sub" }, { cwd: dir })
    expect(result.kind).toBe("err")
  })

  it("requires path", async () => {
    const result = await readTool.execute({}, { cwd: dir })
    expect(result.kind).toBe("err")
  })

  it("resolves absolute paths", async () => {
    const result = await readTool.execute({ path: join(dir, "hello.txt") }, { cwd: "/tmp" })
    expect(result.kind).toBe("ok")
  })
})

describe("write tool", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("writes a new file", async () => {
    const result = await writeTool.execute({ path: "new.txt", content: "fresh" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.bytesWritten).toBe(5)
    }
    const content = await readFile(join(dir, "new.txt"), "utf8")
    expect(content).toBe("fresh")
  })

  it("overwrites existing file", async () => {
    await writeTool.execute({ path: "hello.txt", content: "overwritten" }, { cwd: dir })
    const content = await readFile(join(dir, "hello.txt"), "utf8")
    expect(content).toBe("overwritten")
  })

  it("creates parent directories", async () => {
    const result = await writeTool.execute(
      { path: "a/b/c/deep.txt", content: "deep" },
      { cwd: dir },
    )
    expect(result.kind).toBe("ok")
    expect(existsSync(join(dir, "a/b/c/deep.txt"))).toBe(true)
  })

  it("requires path", async () => {
    const result = await writeTool.execute({ content: "data" }, { cwd: dir })
    expect(result.kind).toBe("err")
  })
})

describe("patch tool", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("replaces single occurrence", async () => {
    const result = await patchTool.execute(
      { path: "hello.txt", oldText: "world", newText: "butterfly" },
      { cwd: dir },
    )
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.patched).toBe(true)
    }
    const content = await readFile(join(dir, "hello.txt"), "utf8")
    expect(content).toContain("hello butterfly")
  })

  it("fails when oldText not found", async () => {
    const result = await patchTool.execute(
      { path: "hello.txt", oldText: "zzzzz", newText: "aaa" },
      { cwd: dir },
    )
    expect(result.kind).toBe("err")
  })

  it("fails when oldText matches multiple times", async () => {
    await writeFile(join(dir, "multi.txt"), "foo foo foo\n")
    const result = await patchTool.execute(
      { path: "multi.txt", oldText: "foo", newText: "bar" },
      { cwd: dir },
    )
    expect(result.kind).toBe("err")
  })

  it("requires oldText", async () => {
    const result = await patchTool.execute({ path: "hello.txt", newText: "bar" }, { cwd: dir })
    expect(result.kind).toBe("err")
  })
})

describe("bash tool", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("runs a command and returns output", async () => {
    const result = await bashTool.execute({ command: "echo hello" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.stdout.trim()).toBe("hello")
      expect(result.output.exitCode).toBe(0)
    }
  })

  it("captures non-zero exit code", async () => {
    const result = await bashTool.execute({ command: "false" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.exitCode).not.toBe(0)
    }
  })

  it("requires command", async () => {
    const result = await bashTool.execute({}, { cwd: dir })
    expect(result.kind).toBe("err")
  })

  it("preserves working directory (account for /private symlink on macOS)", async () => {
    const result = await bashTool.execute({ command: "pwd" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      const stdout = result.output.stdout.trim()
      const realDir = realpathSync(dir)
      expect(stdout).toBe(realDir)
    }
  })
})

describe("grep tool", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("finds matching lines", async () => {
    const result = await grepTool.execute({ query: "hello" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.matches.length).toBeGreaterThanOrEqual(1)
      expect(result.output.matches[0].content).toContain("hello")
    }
  })

  it("returns empty for no match", async () => {
    const result = await grepTool.execute({ query: "zzzznope" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.matches).toHaveLength(0)
    }
  })

  it("requires query", async () => {
    const result = await grepTool.execute({}, { cwd: dir })
    expect(result.kind).toBe("err")
  })

  it("filters by path", async () => {
    const result = await grepTool.execute({ query: "nested", path: "sub" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.matches.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("handles invalid regex", async () => {
    const result = await grepTool.execute({ query: "[" }, { cwd: dir })
    expect(result.kind).toBe("err")
  })
})

describe("glob tool", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("finds files matching pattern", async () => {
    const result = await globTool.execute({ pattern: "*.txt" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.files).toContain("hello.txt")
    }
  })

  it("finds files recursively", async () => {
    const result = await globTool.execute({ pattern: "**/*.txt" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.files).toContain("hello.txt")
      expect(result.output.files).toContain("sub/nested.txt")
    }
  })

  it("returns empty for no match", async () => {
    const result = await globTool.execute({ pattern: "*.xyz" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.files).toHaveLength(0)
    }
  })

  it("requires pattern", async () => {
    const result = await globTool.execute({}, { cwd: dir })
    expect(result.kind).toBe("err")
  })
})

describe("list tool", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("lists root directory entries", async () => {
    const result = await listTool.execute({ path: "." }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      const names = result.output.entries.map((e: { name: string }) => e.name)
      expect(names).toContain("hello.txt")
      expect(names).toContain("sub")
    }
  })

  it("lists subdirectory entries", async () => {
    const result = await listTool.execute({ path: "sub" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      const names = result.output.entries.map((e: { name: string }) => e.name)
      expect(names).toContain("nested.txt")
    }
  })

  it("returns error for non-existent path", async () => {
    const result = await listTool.execute({ path: "nonexistent" }, { cwd: dir })
    expect(result.kind).toBe("err")
  })

  it("defaults to cwd when no path given", async () => {
    const result = await listTool.execute({}, { cwd: dir })
    expect(result.kind).toBe("ok")
  })

  it("identifies file vs dir kinds", async () => {
    const result = await listTool.execute({ path: "." }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      const files = result.output.entries.filter((e: { kind: string }) => e.kind === "file")
      const dirs = result.output.entries.filter((e: { kind: string }) => e.kind === "dir")
      expect(files.length).toBeGreaterThan(0)
      expect(dirs.length).toBeGreaterThan(0)
    }
  })
})
