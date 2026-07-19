import { mkdtempSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GPTTokenizer, SCE } from "@butterfly/context"
import { bench, describe } from "vitest"

async function createLargeDir(fileCount: number, contentSize = 50): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sce-adv-bench-"))
  for (let i = 0; i < fileCount; i++) {
    const subdir = join(dir, `dir${i % 25}`)
    await mkdir(subdir, { recursive: true })
    const content = "x".repeat(contentSize) + `\nexport const v${i} = ${i}\n`
    await writeFile(join(subdir, `f${i}.ts`), content)
  }
  return dir
}

describe("SCE advanced bench", async () => {
  const tok = new GPTTokenizer()
  const sce = new SCE(tok)
  const largeDir = await createLargeDir(2000, 100)
  const deepDir = mkdtempSync(join(tmpdir(), "sce-deep-bench-"))

  // Create deep nesting
  for (let depth = 0; depth < 15; depth++) {
    let current = deepDir
    for (let d = 0; d < depth; d++) {
      current = join(current, `level${d}`)
    }
    await mkdir(current, { recursive: true })
    await writeFile(join(current, `f${depth}.ts`), `export const v${depth} = ${depth}\n`)
  }

  bench("cold cache, 2000 files, 100 char content each", async () => {
    const s = new SCE(tok)
    await s.select("v1500", { cwd: largeDir })
  })

  bench("cache hit, 2000 files", async () => {
    const s = new SCE(tok)
    await s.select("v1500", { cwd: largeDir })
    await s.select("v1500", { cwd: largeDir })
  })

  bench("deeply nested directory (15 levels)", async () => {
    const s = new SCE(tok)
    await s.select("v14", { cwd: deepDir })
  })

  bench("maxFiles limit respected", async () => {
    const s = new SCE(tok)
    await s.select("export", { cwd: largeDir, maxFiles: 1 })
  })

  bench("concurrent selects (5 simultaneous)", async () => {
    const s = new SCE(tok)
    await Promise.all([
      s.select("v100", { cwd: largeDir }),
      s.select("v200", { cwd: largeDir }),
      s.select("v300", { cwd: largeDir }),
      s.select("v400", { cwd: largeDir }),
      s.select("v500", { cwd: largeDir }),
    ])
  })
})
