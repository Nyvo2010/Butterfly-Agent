import { readdir, stat } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import type { Tool } from "../types"
import { isPathInWorkspace } from "../types"

export const listTool: Tool<{ entries: Array<{ name: string; kind: "file" | "dir" }> }> = {
  name: "list",
  description: "List immediate entries of a directory (default cwd).",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const path = String(input.path ?? ".")
    const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path)
    if (ctx.workspaceRoots && !(await isPathInWorkspace(abs, ctx.workspaceRoots))) {
      return { kind: "err", message: `access denied: ${path} is outside the workspace` }
    }
    try {
      const entries = await readdir(abs, { withFileTypes: true })
      const mapped = await Promise.all(
        entries.map(async (e) => {
          if (e.isDirectory()) return { name: e.name, kind: "dir" as const }
          if (e.isFile()) return { name: e.name, kind: "file" as const }
          if (e.isSymbolicLink()) {
            try {
              const st = await stat(join(abs, e.name))
              return { name: e.name, kind: (st.isDirectory() ? "dir" : "file") as "dir" | "file" }
            } catch {
              return { name: e.name, kind: "file" as const }
            }
          }
          return { name: e.name, kind: "file" as const }
        }),
      )
      return { kind: "ok", output: { entries: mapped } }
    } catch (err) {
      return { kind: "err", message: `list failed: ${(err as Error).message}` }
    }
  },
}
