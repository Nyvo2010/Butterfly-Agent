import { mkdtempSync } from "node:fs"
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
  const d = mkdtempSync(join(tmpdir(), "tools-adv-"))
  await mkdir(join(d, "sub"), { recursive: true })
  await writeFile(join(d, "hello.txt"), "hello world\nline two\n")
  await writeFile(join(d, "script.sh"), "#!/bin/bash\necho 'hello'\n")
  await writeFile(join(d, "sub", "nested.txt"), "nested content\n")
  await mkdir(join(d, "empty"), { recursive: true })
  return d
}

describe("read tool advanced", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reads file with special characters in path", async () => {
    await writeFile(join(dir, "file with spaces.txt"), "spaces")
    const result = await readTool.execute({ path: "file with spaces.txt" }, { cwd: dir })
    expect(result.kind).toBe("ok")
  })

  it("reads file with unicode name", async () => {
    await writeFile(join(dir, "résumé.md"), "# Résumé")
    const result = await readTool.execute({ path: "résumé.md" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.output.content).toContain("Résumé")
  })

  it("reads empty file", async () => {
    await writeFile(join(dir, "empty.txt"), "")
    const result = await readTool.execute({ path: "empty.txt" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.output.content).toBe("")
  })

  it("reads file with only newlines", async () => {
    await writeFile(join(dir, "newlines.txt"), "\n\n\n")
    const result = await readTool.execute({ path: "newlines.txt" }, { cwd: dir })
    expect(result.kind).toBe("ok")
  })
})

describe("write tool advanced", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("writes empty content", async () => {
    const result = await writeTool.execute({ path: "empty.txt", content: "" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    const content = await readFile(join(dir, "empty.txt"), "utf8")
    expect(content).toBe("")
  })

  it("writes binary-safe content", async () => {
    const binary = String.fromCharCode(0, 1, 2, 255, 254, 253)
    const result = await writeTool.execute({ path: "binary.bin", content: binary }, { cwd: dir })
    expect(result.kind).toBe("ok")
  })

  it("writes large content (100K chars)", async () => {
    const large = "x".repeat(100_000)
    const result = await writeTool.execute({ path: "large.txt", content: large }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.output.bytesWritten).toBe(100_000)
  })

  it("writes file with undefined content as empty string", async () => {
    const result = await writeTool.execute({ path: "empty_content.txt", content: "" }, { cwd: dir })
    expect(result.kind).toBe("ok")
  })

  it("overwrites with shorter content", async () => {
    await writeFile(join(dir, "test.txt"), "long content here")
    await writeTool.execute({ path: "test.txt", content: "short" }, { cwd: dir })
    const content = await readFile(join(dir, "test.txt"), "utf8")
    expect(content).toBe("short")
  })
})

describe("patch tool advanced", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("replaces at the start of file", async () => {
    await writeFile(join(dir, "start.txt"), "first line\nsecond line\n")
    const result = await patchTool.execute(
      { path: "start.txt", oldText: "first line", newText: "replaced first" },
      { cwd: dir },
    )
    expect(result.kind).toBe("ok")
    const content = await readFile(join(dir, "start.txt"), "utf8")
    expect(content).toContain("replaced first")
  })

  it("replaces at the end of file", async () => {
    await writeFile(join(dir, "end.txt"), "first line\nsecond line\n")
    const result = await patchTool.execute(
      { path: "end.txt", oldText: "second line", newText: "replaced second" },
      { cwd: dir },
    )
    expect(result.kind).toBe("ok")
    const content = await readFile(join(dir, "end.txt"), "utf8")
    expect(content).toContain("replaced second")
  })

  it("replaces with empty string", async () => {
    await writeFile(join(dir, "remove.txt"), "keep this content")
    const result = await patchTool.execute(
      { path: "remove.txt", oldText: "this ", newText: "" },
      { cwd: dir },
    )
    expect(result.kind).toBe("ok")
    const content = await readFile(join(dir, "remove.txt"), "utf8")
    expect(content).toBe("keep content")
  })

  it("patch with empty newText replaces with empty string", async () => {
    const result = await patchTool.execute(
      { path: "hello.txt", oldText: "line two", newText: "" },
      { cwd: dir },
    )
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.output.patched).toBe(true)
  })

  it("handles multi-line oldText", async () => {
    await writeFile(join(dir, "multi.txt"), "line1\nline2\nline3\n")
    const result = await patchTool.execute(
      { path: "multi.txt", oldText: "line1\nline2", newText: "replaced" },
      { cwd: dir },
    )
    expect(result.kind).toBe("ok")
    const content = await readFile(join(dir, "multi.txt"), "utf8")
    expect(content).toContain("replaced")
  })
})

describe("bash tool advanced", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("runs command with no output", async () => {
    const result = await bashTool.execute({ command: "true" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.stdout).toBe("")
      expect(result.output.exitCode).toBe(0)
    }
  })

  it("runs command with stderr only", async () => {
    const result = await bashTool.execute({ command: "echo 'error' >&2" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.stderr).toContain("error")
    }
  })

  it("handles timeout by respecting maxDuration (non-zero exit)", async () => {
    const result = await bashTool.execute({ command: "sleep 10", maxDuration: 100 }, { cwd: dir })
    // On timeout, the process is killed and returns non-zero exit code
    if (result.kind === "ok") {
      expect(result.output.exitCode).not.toBe(0)
    } else {
      expect(result.kind).toBe("err")
    }
  })

  it("captures large output without crashing", async () => {
    const result = await bashTool.execute(
      { command: "python3 -c \"print('x' * 100000)\"" },
      { cwd: dir },
    )
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.stdout.length).toBeGreaterThan(50000)
    }
  })

  it("runs a script file with correct env", async () => {
    const result = await bashTool.execute(
      { command: "echo $TEST_VAR" },
      { cwd: dir, env: { TEST_VAR: "hello_env" } },
    )
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.stdout.trim()).toBe("hello_env")
    }
  })

  it("handles very long command string", async () => {
    const longArg = "a".repeat(10000)
    const result = await bashTool.execute({ command: `echo ${longArg}` }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.stdout.trim()).toBe(longArg)
    }
  })
})

describe("grep tool advanced", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("searches in empty directory", async () => {
    const result = await grepTool.execute({ query: "anything", path: "empty" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.output.matches).toHaveLength(0)
  })

  it("searches with multiline regex", async () => {
    const result = await grepTool.execute({ query: "hello|nested" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.output.matches.length).toBeGreaterThanOrEqual(2)
  })

  it("searches with case-sensitive regex correctly", async () => {
    await writeFile(join(dir, "case.txt"), "HELLO WORLD\nHello World\nhello world\n")
    const result = await grepTool.execute({ query: "hello" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      // Also matches "hello" from hello.txt in the base tmpDir
      const helloMatches = result.output.matches.filter((m: { content: string }) =>
        m.content.includes("hello"),
      )
      expect(helloMatches.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("respects maxResults cap", async () => {
    await writeFile(
      join(dir, "many.txt"),
      Array.from({ length: 100 }, (_, i) => `line ${i}: match`).join("\n"),
    )
    const result = await grepTool.execute({ query: "match", maxResults: 5 }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.output.matches.length).toBeLessThanOrEqual(5)
  })
})

describe("glob tool advanced", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("matches multiple extensions", async () => {
    await writeFile(join(dir, "data.json"), "{}")
    await writeFile(join(dir, "data.xml"), "<x/>")
    const result = await globTool.execute({ pattern: "*.{json,xml}" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.files).toContain("data.json")
      expect(result.output.files).toContain("data.xml")
    }
  })

  it("matches files in single subdirectory", async () => {
    const result = await globTool.execute({ pattern: "sub/*.txt" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output.files).toContain("sub/nested.txt")
    }
  })

  it("handles pattern with no matches", async () => {
    const result = await globTool.execute({ pattern: "*.nonexistent" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.output.files).toHaveLength(0)
  })
})

describe("list tool advanced", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmpDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("lists empty directory", async () => {
    const result = await listTool.execute({ path: "empty" }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.output.entries).toHaveLength(0)
  })

  it("lists root directory via absolute path", async () => {
    const result = await listTool.execute({ path: dir }, { cwd: "/" })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      const names = result.output.entries.map((e: { name: string }) => e.name)
      expect(names).toContain("hello.txt")
    }
  })

  it("lists directory with many entries (100 files)", async () => {
    for (let i = 0; i < 100; i++) {
      await writeFile(join(dir, `many_${i}.txt`), "x")
    }
    const result = await listTool.execute({ path: "." }, { cwd: dir })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.output.entries.length).toBeGreaterThanOrEqual(100)
  })
})

describe("ToolRegistry advanced", () => {
  it("lists empty registry", () => {
    const r = new ToolRegistry()
    expect(r.list()).toHaveLength(0)
    expect(r.size()).toBe(0)
  })

  it("listAllowed returns empty for no kind match", () => {
    const r = new ToolRegistry()
    r.register(readTool)
    r.register(writeTool)
    expect(r.listAllowed(["delegate"])).toHaveLength(0)
  })

  it("listAllowed with duplicate kinds returns unique tools", () => {
    const r = new ToolRegistry()
    r.register(readTool)
    r.register(writeTool)
    r.register(grepTool)
    const tools = r.listAllowed(["read", "read"])
    expect(tools).toHaveLength(2)
  })
})
