import { readFile, writeFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Tool } from "../types"

export const patchTool: Tool<{ patched: boolean }> = {
  name: "patch",
  description:
    "Replace oldText with newText exactly once in a file. Errors if oldText matches zero or multiple times.",
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const path = String(input.path ?? "")
    const oldText = String(input.oldText ?? "")
    const newText = String(input.newText ?? "")
    if (!path) return { kind: "err", message: "path is required" }
    if (!oldText) return { kind: "err", message: "oldText is required" }
    const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path)
    try {
      const before = await readFile(abs, "utf8")
      const occurrences = before.split(oldText).length - 1
      if (occurrences === 0) return { kind: "err", message: `oldText not found in ${path}` }
      if (occurrences > 1) {
        return {
          kind: "err",
          message: `oldText matches ${occurrences} times in ${path}; must be unique`,
        }
      }
      const after = before.replace(oldText, newText)
      await writeFile(abs, after, "utf8")
      return { kind: "ok", output: { patched: true } }
    } catch (err) {
      return { kind: "err", message: `patch failed: ${(err as Error).message}` }
    }
  },
}
