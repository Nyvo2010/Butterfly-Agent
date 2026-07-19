import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

// Walks upward from `start` until it finds pnpm-workspace.yaml.
// Returns `start` if not found — caller should accept either the root or the original cwd.
export function findWorkspaceRoot(start: string = process.cwd()): string {
  let dir = resolve(start)
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}
