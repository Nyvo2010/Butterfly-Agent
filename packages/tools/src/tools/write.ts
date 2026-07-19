import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import type { Tool } from "../types"

export const writeTool: Tool<{ bytesWritten: number }> = {
  name: "write",
  description: "Write content to a file (overwrites if present). Creates parent directories.",
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const path = String(input.path ?? "")
    const content = String(input.content ?? "")
    if (!path) return { kind: "err", message: "path is required" }
    const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path)
    try {
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, "utf8")
      return { kind: "ok", output: { bytesWritten: Buffer.byteLength(content, "utf8") } }
    } catch (err) {
      return { kind: "err", message: `write failed: ${(err as Error).message}` }
    }
  },
}
