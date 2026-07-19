import { readFile, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Tool } from "../types"

export const readTool: Tool<{ content: string; size: number }> = {
  name: "read",
  description: "Read the contents of a file (UTF-8). Returns content and byte size.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const path = String(input.path ?? "")
    if (!path) return { kind: "err", message: "path is required" }
    const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path)
    try {
      const st = await stat(abs)
      if (!st.isFile()) return { kind: "err", message: `${abs} is not a file` }
      const content = await readFile(abs, "utf8")
      return { kind: "ok", output: { content, size: st.size } }
    } catch (err) {
      return { kind: "err", message: `read failed: ${(err as Error).message}` }
    }
  },
}
