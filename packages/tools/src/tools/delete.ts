import { rm } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Tool } from "../types"

export const deleteTool: Tool<{ deleted: boolean }> = {
  name: "delete",
  description: "Delete a file at the given path.",
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const path = String(input.path ?? "")
    if (!path) return { kind: "err", message: "path is required" }
    const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path)
    try {
      await rm(abs, { force: true })
      return { kind: "ok", output: { deleted: true } }
    } catch (err) {
      return { kind: "err", message: `delete failed: ${(err as Error).message}` }
    }
  },
}
