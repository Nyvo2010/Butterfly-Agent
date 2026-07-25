import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { formatFile } from "../formatter"
import type { Tool } from "../types"
import { isPathInWorkspace } from "../types"

const MAX_CONTENT_BYTES = 10 * 1024 * 1024

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
    if (ctx.workspaceRoots && !(await isPathInWorkspace(abs, ctx.workspaceRoots))) {
      return { kind: "err", message: `access denied: ${path} is outside the workspace` }
    }
    const contentBytes = Buffer.byteLength(content, "utf8")
    if (contentBytes > MAX_CONTENT_BYTES) {
      return {
        kind: "err",
        message: `content too large: ${contentBytes} bytes exceeds ${MAX_CONTENT_BYTES} byte limit`,
      }
    }
    try {
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, "utf8")
      // Auto-format after write if a matching formatter is available.
      formatFile(ctx.cwd, abs)
      return { kind: "ok", output: { bytesWritten: contentBytes } }
    } catch (err) {
      return { kind: "err", message: `write failed: ${(err as Error).message}` }
    }
  },
}
