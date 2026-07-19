import { readdir } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import picomatch from "picomatch"
import type { Tool } from "../types"

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next"])

export const globTool: Tool<{ files: string[] }> = {
  name: "glob",
  description: "Find files matching a glob pattern under `path` (default cwd).",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const pattern = String(input.pattern ?? "")
    const basePath = String(input.path ?? ".")
    if (!pattern) return { kind: "err", message: "pattern is required" }
    const base = isAbsolute(basePath) ? basePath : resolve(ctx.cwd, basePath)
    const matcher = picomatch(pattern, { dot: true })
    const files: string[] = []
    const all = await walk(base)
    for (const file of all) {
      const rel = relative(base, file).split(sep).join("/")
      if (matcher(rel)) files.push(rel)
    }
    files.sort()
    return { kind: "ok", output: { files } }
  },
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) out.push(...(await walk(full)))
      else if (e.isFile()) out.push(full)
    }
  } catch {
    return out
  }
  return out
}
