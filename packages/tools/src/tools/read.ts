import { readFile, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Tool } from "../types"
import { isPathInWorkspace } from "../types"

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

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
    if (ctx.workspaceRoots && !(await isPathInWorkspace(abs, ctx.workspaceRoots))) {
      return { kind: "err", message: `access denied: ${path} is outside the workspace` }
    }
    try {
      // Check file size BEFORE reading to prevent OOM on large files.
      const st = await stat(abs)
      if (st.size > MAX_FILE_SIZE_BYTES) {
        return {
          kind: "err",
          message: `file too large: ${abs} exceeds ${MAX_FILE_SIZE_BYTES} byte limit`,
        }
      }
      const content = await readFile(abs, "utf8")
      return { kind: "ok", output: { content, size: Buffer.byteLength(content, "utf8") } }
    } catch (err) {
      return { kind: "err", message: `read failed: ${(err as Error).message}` }
    }
  },
}
