/**
 * Git-based session snapshot system — mirrors OpenCode's Snapshot architecture.
 *
 * Uses a git repository (stored in ~/.butterfly/snapshots/{project-hash}/) to:
 *   - track(): Snapshot the working tree → returns a git tree hash
 *   - patch(hash): Diff from a previous snapshot to current → returns changed files
 *   - restore(hash): Checkout files from a snapshot hash
 *   - revert(patches): Revert specific files to their state in previous snapshots
 *
 * This is a lightweight clone of OpenCode's approach: git handles all the
 * heavy lifting (diffs, dedup, compression, checkout) with proven reliability.
 */

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

interface SnapshotPatch {
  hash: string
  files: string[]
}

interface SnapshotService {
  /** Initialize the git snapshot repository. Call once per project. */
  init(worktree: string): Promise<void>
  /** Snapshot the working tree. Returns the git tree hash. */
  track(worktree: string): Promise<string | undefined>
  /** Get changed files between a snapshot and current state. */
  patch(worktree: string, hash: string): Promise<SnapshotPatch>
  /** Restore the entire working tree to a snapshot. */
  restore(worktree: string, snapshot: string): Promise<void>
  /** Revert specific files to their state in previous snapshots. */
  revert(worktree: string, patches: SnapshotPatch[]): Promise<void>
  /** Get the unified diff between a snapshot and current state. */
  diff(worktree: string, hash: string): Promise<string>
}

/**
 * Create a snapshot service that stores git data in a project-specific
 * directory under ~/.butterfly/snapshots/.
 */
function createSnapshotService(): SnapshotService {
  const projectHashes = new Map<string, string>()

  function getGitDir(worktree: string): string {
    let hash = projectHashes.get(worktree)
    if (!hash) {
      hash = createHash("sha256").update(resolve(worktree)).digest("hex").slice(0, 16)
      projectHashes.set(worktree, hash)
    }
    return join(homedir(), ".butterfly", "snapshots", hash)
  }

  async function git(worktree: string, args: string[], opts?: { stdin?: string; cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
    const gitDir = getGitDir(worktree)
    const fullArgs = [
      "--git-dir", gitDir,
      "--work-tree", worktree,
      ...args,
    ]
    try {
      const { stdout, stderr } = await execFileAsync("git", fullArgs, {
        cwd: opts?.cwd ?? worktree,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
        ...(opts?.stdin !== undefined ? {} : {}),
      })
      return { code: 0, stdout, stderr }
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string }
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
    }
  }

  return {
    async init(worktree: string): Promise<void> {
      const gitDir = getGitDir(worktree)
      if (existsSync(join(gitDir, "HEAD"))) return

      mkdirSync(gitDir, { recursive: true })
      await git(worktree, ["init"], { cwd: gitDir })
      // Configure for large repos (matching OpenCode).
      await git(worktree, ["config", "core.autocrlf", "false"])
      await git(worktree, ["config", "core.longpaths", "true"])
      await git(worktree, ["config", "core.symlinks", "true"])
      await git(worktree, ["config", "core.fsmonitor", "false"])
      await git(worktree, ["config", "feature.manyFiles", "true"])
      await git(worktree, ["config", "index.version", "4"])
    },

    async track(worktree: string): Promise<string | undefined> {
      await this.init(worktree)

      // Stage all files.
      const add = await git(worktree, ["add", "--all", "--", "."])
      if (add.code !== 0) return undefined

      // Write tree.
      const tree = await git(worktree, ["write-tree"])
      if (tree.code !== 0) return undefined

      return tree.stdout.trim() || undefined
    },

    async patch(worktree: string, hash: string): Promise<SnapshotPatch> {
      await this.init(worktree)

      // Stage current state.
      await git(worktree, ["add", "--all", "--", "."])

      // Diff from snapshot to current.
      const diff = await git(worktree, [
        "diff", "--cached", "--name-only", hash, "--", ".",
      ])

      const files = diff.stdout.trim().split("\n").filter(Boolean)
      return { hash, files }
    },

    async restore(worktree: string, snapshot: string): Promise<void> {
      await this.init(worktree)
      await git(worktree, ["read-tree", snapshot])
      await git(worktree, ["checkout-index", "-a", "-f"])
    },

    async revert(worktree: string, patches: SnapshotPatch[]): Promise<void> {
      await this.init(worktree)

      const seen = new Set<string>()
      for (const patch of patches) {
        for (const file of patch.files) {
          if (seen.has(file)) continue
          seen.add(file)
          await git(worktree, ["checkout", patch.hash, "--", file])
        }
      }
    },

    async diff(worktree: string, hash: string): Promise<string> {
      await this.init(worktree)

      // Stage current state.
      await git(worktree, ["add", "--all", "--", "."])

      const diff = await git(worktree, [
        "diff", "--cached", "--no-ext-diff", hash, "--", ".",
      ])

      return diff.stdout.trim()
    },
  }
}

/** Singleton for the process lifetime. */
let instance: SnapshotService | undefined

export function getSnapshotService(): SnapshotService {
  if (!instance) instance = createSnapshotService()
  return instance
}
