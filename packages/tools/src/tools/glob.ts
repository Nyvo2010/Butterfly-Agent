import { isAbsolute, relative, resolve, sep } from "node:path"
import picomatch from "picomatch"
import type { Tool } from "../types"
import { isPathInWorkspace } from "../types"
import { DEFAULT_SKIP_DIRS, walk } from "./walk"

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
    // Enforce workspace boundary.
    if (ctx.workspaceRoots) {
      const isWithin = await isPathInWorkspace(base, ctx.workspaceRoots)
      if (!isWithin) {
        return { kind: "err", message: `access denied: ${basePath} is outside the workspace` }
      }
    }
    const matcher = picomatch(pattern, { dot: true })
    const files: string[] = []
    const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(ctx.skipDirs ?? [])])
    const all = await walk(base, skipDirs)
    for (const file of all) {
      const rel = relative(base, file).split(sep).join("/")
      if (matcher(rel)) files.push(rel)
    }
    files.sort()
    return { kind: "ok", output: { files } }
  },
}
