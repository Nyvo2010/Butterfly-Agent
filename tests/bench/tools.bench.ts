import { mkdtempSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bashTool, globTool, grepTool, readTool, ToolRegistry, writeTool } from "@butterfly/tools"
import { bench, describe } from "vitest"

async function createBenchDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "tools-bench-"))
  await writeFile(join(dir, "small.txt"), "hello world\n")
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test", version: "1.0.0" }))
  // Create a 1000-line file for grep bench
  const lines: string[] = []
  for (let i = 0; i < 1000; i++) {
    lines.push(`line ${i}: export const value${i} = ${i}`)
  }
  await writeFile(join(dir, "large.ts"), lines.join("\n"))
  // Create 500 files in subdirs for glob bench
  await mkdir(join(dir, "manyfiles"), { recursive: true })
  for (let i = 0; i < 500; i++) {
    await mkdir(join(dir, "manyfiles", `sub${i % 25}`), { recursive: true })
    await writeFile(
      join(dir, "manyfiles", `sub${i % 25}`, `f${i}.ts`),
      `export const v${i} = ${i}\n`,
    )
  }
  return dir
}

let benchDir: string

describe("Tools bench", async () => {
  benchDir = await createBenchDir()
  const ctx = { cwd: benchDir }

  bench("read small file", async () => {
    await readTool.execute({ path: "small.txt" }, ctx)
  })

  bench("read large file (1000 lines)", async () => {
    await readTool.execute({ path: "large.ts" }, ctx)
  })

  bench("write small file", async () => {
    await writeTool.execute({ path: "out.txt", content: "data" }, ctx)
  })

  bench("grep on large file", async () => {
    await grepTool.execute({ query: "export const value500" }, ctx)
  })

  bench("glob all ts files", async () => {
    await globTool.execute({ pattern: "**/*.ts" }, ctx)
  })

  bench("glob in 500-file tree", async () => {
    await globTool.execute({ pattern: "manyfiles/**/*.ts" }, ctx)
  })

  bench("bash echo", async () => {
    await bashTool.execute({ command: "echo hello" }, ctx)
  })

  bench("ToolRegistry listAllowed", () => {
    const r = new ToolRegistry()
    r.register(readTool)
    r.register(writeTool)
    r.register(grepTool)
    r.listAllowed(["read", "write"])
  })
})
