import { readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { SKIP_DIRS, walk } from "@butterfly/core"
import type { Tool } from "../types"
import { isPathInWorkspace } from "../types"

const MAX_GREP_FILE_BYTES = 1024 * 1024

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
    // Enforce workspace boundary.
    if (ctx.workspaceRoots) {
      const isWithin = await isPathInWorkspace(base, ctx.workspaceRoots)
      if (!isWithin) {
        return { kind: "err", message: `access denied: ${basePath} is outside the workspace` }
      }
    }
    let re: RegExp
    try {
      re = new RegExp(query, "gm")
    } catch (_err) {
      return { kind: "err", message: `invalid regex: ${(_err as Error).message}` }
    }
    // ReDoS guard: reject patterns likely to cause catastrophic backtracking.
    // Source length cap prevents pathological regex. Nested quantifier check
    // catches patterns like (a+)+ or (a|aa)+ that backtrack exponentially.
    if (re.source.length > 500 || /\)[*+{]/.test(re.source) || /\+[*+]/.test(re.source)) {
      return { kind: "err", message: "regex pattern too complex; simplify or narrow the search" }
    }
    const matches: Array<{ file: string; line: number; content: string }> = []
    const skipDirs = new Set([...SKIP_DIRS, ...(ctx.skipDirs ?? [])])
    const files = await walk(base, skipDirs)
    for (const file of files) {
      if (matches.length >= maxResults) break
      let st: Awaited<ReturnType<typeof stat>> | undefined
      try {
        st = await stat(file)
      } catch {
        continue
      }
      if (st.size > MAX_GREP_FILE_BYTES) continue
      let content: string
      try {
        content = await readFile(file, "utf8")
      } catch {
        continue
      }
      const lines = content.split("\n")
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        const line = lines[i]
        if (re.test(line)) {
          matches.push({
            file: relative(base, file).split(sep).join("/"),
            line: i + 1,
            content: line,
          })
        }
        re.lastIndex = 0
      }
    }
    return { kind: "ok", output: { matches } }
  },
}
