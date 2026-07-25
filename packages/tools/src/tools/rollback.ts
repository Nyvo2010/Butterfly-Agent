import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import type { Tool } from "../types"
import { isPathInWorkspace } from "../types"

export interface RollbackToolDeps {
  getFileChanges(): Array<{
    path: string
    kind: string
    before?: string
    after?: string
    at: string
  }>
  cwd: string
}

export function createRollbackTool(deps: RollbackToolDeps): Tool<{ restored: string[] }> {
  return {
    name: "rollback",
    description:
      "Restore files to their state before the last mutation. " +
      "Uses checkpoint data to undo write, patch, delete, and diff_patch operations. " +
      "Call without arguments to rollback all changes, or specify a file path.",
    kind: "write",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional: specific file to rollback. If omitted, rolls back all changes.",
        },
      },
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const targetPath = input.path ? String(input.path) : undefined
      const changes = deps.getFileChanges()
      if (changes.length === 0) {
        return { kind: "ok", output: { restored: [] } }
      }

      const restored: string[] = []

      const toRestore = targetPath
        ? [...changes].reverse().filter((c) => {
            // Normalize both paths to absolute before comparing.
            const changeAbs = isAbsolute(c.path) ? c.path : resolve(deps.cwd, c.path)
            const targetAbs = isAbsolute(targetPath) ? targetPath : resolve(deps.cwd, targetPath)
            return changeAbs === targetAbs
          })
        : [...changes].reverse()

      for (const change of toRestore) {
        const abs = isAbsolute(change.path) ? change.path : resolve(deps.cwd, change.path)
        if (ctx.workspaceRoots && !(await isPathInWorkspace(abs, ctx.workspaceRoots))) {
          return {
            kind: "err",
            message: `rollback denied: ${change.path} is outside the workspace`,
          }
        }

        try {
          // Restore from before-content (delete + write/patch/diff_patch share the same logic).
          if (change.before !== undefined) {
            await mkdir(dirname(abs), { recursive: true })
            await writeFile(abs, change.before, "utf8")
            restored.push(change.path)
          } else {
            // No before-content: this was a newly created file. Delete it.
            await rm(abs, { force: true })
            restored.push(change.path)
          }
        } catch (err) {
          return {
            kind: "err",
            message: `rollback failed for ${change.path}: ${(err as Error).message}`,
          }
        }
      }

      return { kind: "ok", output: { restored: [...new Set(restored)] } }
    },
  }
}
