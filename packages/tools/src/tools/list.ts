import { readdir } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Tool } from "../types"

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
    try {
      const entries = await readdir(abs, { withFileTypes: true })
      return {
        kind: "ok",
        output: {
          entries: entries.map((e) => ({
            name: e.name,
            kind: e.isDirectory() ? "dir" : "file",
          })),
        },
      }
    } catch (err) {
      return { kind: "err", message: `list failed: ${(err as Error).message}` }
    }
  },
}
