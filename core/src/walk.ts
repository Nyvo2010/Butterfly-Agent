import { readdir, realpath, stat } from "node:fs/promises"
import { join } from "node:path"
import { SKIP_DIRS } from "./skip-dirs"

/**
 * Recursively walk a directory tree, returning absolute paths of all files.
 * Tracks visited symlink targets via `realpath` to prevent infinite loops from
 * circular symlinks. Silently skips unreadable entries and broken symlinks.
 *
 * This is the canonical walk implementation used by both SCE and the tools
 * package (glob, grep). Previously duplicated across two files.
 */
export async function walk(
  dir: string,
  skipDirs: Set<string>,
  visited?: Set<string>,
): Promise<string[]> {
  const out: string[] = []
  const seen = visited ?? new Set<string>()
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!entries) return out
  for (const e of entries) {
    if (skipDirs.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await walk(full, skipDirs, seen)))
    } else if (e.isFile()) {
      out.push(full)
    } else if (e.isSymbolicLink()) {
      try {
        const target = await realpath(full)
        if (seen.has(target)) continue
        seen.add(target)
        const st = await stat(full)
        if (st.isDirectory()) out.push(...(await walk(full, skipDirs, seen)))
        else if (st.isFile()) out.push(full)
      } catch {
        // Broken symlink — skip silently.
      }
    }
  }
  return out
}

/**
 * Convenience: walk with the built-in SKIP_DIRS set.
 * Most callers want the default skip list (node_modules, .git, dist, etc.).
 */
export function walkWithDefaults(dir: string): Promise<string[]> {
  return walk(dir, SKIP_DIRS)
}
