import { writeFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Tool } from "../types"

/**
 * Rollback tool: restores files to their previous content using checkpoint data
 * stored in the session's fileChanges (before/after fields).
 *
 * This tool must have access to the session's fileChange records, so it's
 * created via a factory that provides the current fileChanges array.
 */
export interface RollbackToolDeps {
  /** Get all file changes for the current session. */
  getFileChanges(): Array<{ path: string; kind: string; before?: string; after?: string; at: string }>
  /** Get the working directory. */
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
    async execute(input, _ctx) {
      const targetPath = input.path ? String(input.path) : undefined
      const changes = deps.getFileChanges()
      if (changes.length === 0) {
        return { kind: "ok", output: { restored: [] } }
      }

      const restored: string[] = []

      // Filter changes (by path if specified). Process in reverse order
      // so the most recent change is reverted first, then earlier ones.
      const toRestore = targetPath
        ? [...changes].reverse().filter((c) => c.path === targetPath)
        : [...changes].reverse()

      for (const change of toRestore) {
        if (!change.before && change.kind !== "delete") {
          // No checkpoint data — can't restore. Skip.
          continue
        }

        const abs = isAbsolute(change.path) ? change.path : resolve(deps.cwd, change.path)

        try {
          if (change.kind === "delete") {
            // Undo a delete: restore the file content from the before checkpoint.
            if (change.before !== undefined) {
              await writeFile(abs, change.before, "utf8")
              restored.push(change.path)
            }
          } else if (change.before !== undefined) {
            // For write/patch/diff_patch: restore to the before content.
            await writeFile(abs, change.before, "utf8")
            restored.push(change.path)
          } else {
            // File was created (no before content): delete it.
            const { rm } = await import("node:fs/promises")
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
