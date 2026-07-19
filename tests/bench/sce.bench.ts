import { mkdtempSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GPTTokenizer, SCE } from "@butterfly/context"
import { bench, describe } from "vitest"

async function createLargeDir(fileCount: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sce-bench-"))
  for (let i = 0; i < fileCount; i++) {
    const subdir = join(dir, `dir${i % 10}`)
    await mkdir(subdir, { recursive: true })
    await writeFile(join(subdir, `file${i}.ts`), `export function fn${i}() { return ${i} }\n`)
  }
  await writeFile(join(dir, "index.ts"), "export * from './dir0/file0'\n")
  return dir
}

describe("SCE bench", async () => {
  const tok = new GPTTokenizer()
  const smallDir = await createLargeDir(50)
  const largeDir = await createLargeDir(500)
  const sce = new SCE(tok)

  bench("cold cache, small dir (50 files)", async () => {
    const s = new SCE(tok)
    await s.select("fn1", { cwd: smallDir })
  })

  bench("cache hit", async () => {
    await sce.select("fn1", { cwd: smallDir })
  })

  bench("cache miss (different query)", async () => {
    await sce.select("fn2", { cwd: smallDir })
  })

  bench("5 iterations with same query", async () => {
    const s = new SCE(tok)
    await s.select("fn3", { cwd: smallDir })
    for (let i = 0; i < 4; i++) {
      await s.select("fn3", { cwd: smallDir })
    }
  })

  bench("natural language query (needs tokenization)", async () => {
    const s = new SCE(tok)
    await s.select("find all the export functions that return a number", { cwd: smallDir })
  })

  bench("large dir tree (500 files)", async () => {
    const s = new SCE(tok)
    await s.select("fn100", { cwd: largeDir })
  })
})
