import { readdir, readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Tool } from "../types"

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next"])

export const grepTool: Tool<{ matches: Array<{ file: string; line: number; content: string }> }> = {
  name: "grep",
  description:
    "Search for a regex pattern across files under `path` (default cwd). Returns up to `maxResults` line matches.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      path: { type: "string" },
      maxResults: { type: "number" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const query = String(input.query ?? "")
    const basePath = String(input.path ?? ".")
    const maxResults = Number(input.maxResults ?? 50)
    if (!query) return { kind: "err", message: "query is required" }
    const base = isAbsolute(basePath) ? basePath : resolve(ctx.cwd, basePath)
    let re: RegExp
    try {
      re = new RegExp(query, "gm")
    } catch (err) {
      return { kind: "err", message: `invalid regex: ${(err as Error).message}` }
    }
    const matches: Array<{ file: string; line: number; content: string }> = []
    const files = await walk(base)
    for (const file of files) {
      if (matches.length >= maxResults) break
      let content: string
      try {
        content = await readFile(file, "utf8")
      } catch {
        continue
      }
      const lines = content.split("\n")
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (re.test(lines[i])) {
          matches.push({
            file: relative(base, file).split(sep).join("/"),
            line: i + 1,
            content: lines[i],
          })
          re.lastIndex = 0
        }
      }
    }
    return { kind: "ok", output: { matches } }
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
