import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, normalize, relative } from "node:path"
import type { SessionStore } from "./store"
import type { SessionState } from "./types"

function globalSessionsDir(): string {
  return join(homedir(), ".butterfly", "sessions")
}

/**
 * Sanitize a session ID to prevent path traversal attacks.
 * Only allows alphanumeric characters, dashes, underscores, and dots.
 * Rejects any ID containing ".." or "/" or "\\" or starting with ".".
 */
function sanitizeSessionId(id: string): string {
  if (!id || id.startsWith(".") || id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error(`Invalid session ID: ${id}`)
  }
  const sanitized = id.replace(/[^a-zA-Z0-9._-]/g, "_")
  if (sanitized !== id) {
    throw new Error(`Session ID contains invalid characters: ${id}`)
  }
  return id
}

const REQUIRED_SESSION_FIELDS = [
  "id",
  "mode",
  "tier",
  "messages",
  "toolCalls",
  "fileChanges",
  "readFiles",
  "startedAt",
  "updatedAt",
] as const

const STRING_SESSION_FIELDS = new Set(["id", "mode", "tier", "startedAt", "updatedAt"])
const ARRAY_SESSION_FIELDS = new Set(["messages", "toolCalls", "fileChanges", "readFiles"])

function validateSessionState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) return false
  const obj = value as Record<string, unknown>
  for (const field of REQUIRED_SESSION_FIELDS) {
    if (!(field in obj)) return false
    if (STRING_SESSION_FIELDS.has(field) && typeof obj[field] !== "string") return false
    if (ARRAY_SESSION_FIELDS.has(field) && !Array.isArray(obj[field])) return false
  }
  return true
}

// ─── File Locking ──────────────────────────────────────────────────────────────

/** Maximum time (ms) a lock is considered valid before being treated as stale. */
const LOCK_TIMEOUT_MS = 5_000

/** Retry interval (ms) between lock acquisition attempts. */
const LOCK_RETRY_MS = 50

/**
 * Acquire an exclusive lock file for a given path.
 * Uses `wx` (exclusive write) flag to atomically create the lock file.
 * Retries with backoff if the lock is held by another process.
 * Treats locks older than LOCK_TIMEOUT_MS as stale and breaks them.
 */
async function acquireLock(lockPath: string, sessionId: string): Promise<() => Promise<void>> {
  const start = Date.now()
  while (true) {
    try {
      // Try to create the lock file exclusively. If it already exists, EEXIST is thrown.
      const fh = await open(lockPath, "wx")
      await fh.writeFile(`${process.pid}\n${new Date().toISOString()}`, "utf8")
      await fh.close()
      // Return a release function.
      return async () => {
        await rm(lockPath, { force: true }).catch(() => {})
      }
    } catch (err) {
      // Check for stale lock.
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const content = await readFile(lockPath, "utf8")
          const lines = content.trim().split("\n")
          const rawTimestamp = lines[1] ?? ""
          const timestamp = rawTimestamp ? new Date(rawTimestamp).getTime() : 0
          // new Date() on malformed strings returns NaN, which fails the
          // stale-lock check (NaN > N is false). Treat NaN the same as 0
          // (epoch) — always stale if any content exists.
          if (Number.isNaN(timestamp) || Date.now() - timestamp > LOCK_TIMEOUT_MS) {
            // Stale lock — break it and retry.
            await rm(lockPath, { force: true })
            continue
          }
        } catch {
          // Can't read stale lock info — retry.
        }
      } else {
        throw err
      }
    }
    if (Date.now() - start > LOCK_TIMEOUT_MS * 2) {
      throw new Error(
        `Failed to acquire lock for session ${sessionId} after ${LOCK_TIMEOUT_MS * 2}ms`,
      )
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
  }
}

function lockPathFor(sessionPath: string): string {
  return `${sessionPath}.lock`
}

/**
 * FileSystemSessionStore persists sessions as JSON files.
 *
 * When `root` is provided (project-local mode), sessions go to
 * `<root>/.butterfly/sessions/<id>.json`.
 *
 * When `root` is omitted (global mode), sessions go to
 * `~/.butterfly/sessions/<id>.json` — shared across all projects,
 * matching Opencode's convention.
 *
 * File locking: writes acquire an exclusive `.lock` file (with stale-lock
 * detection) to protect against concurrent access from multiple processes.
 * This makes the store safe for multi-process use.
 */
export class FileSystemSessionStore implements SessionStore {
  private readonly root: string | null
  private readonly onError: (message: string) => void

  constructor(root?: string, onError?: (message: string) => void) {
    this.root = root ?? null
    this.onError = onError ?? ((msg) => console.error(msg))
  }

  private sessionsDir(): string {
    const dir = this.root ? join(this.root, ".butterfly", "sessions") : globalSessionsDir()
    return normalize(dir)
  }

  private sessionPath(id: string): string {
    const safeId = sanitizeSessionId(id)
    const full = join(this.sessionsDir(), `${safeId}.json`)
    // Verify the resolved path is still within the sessions directory.
    const rel = relative(this.sessionsDir(), normalize(full))
    if (rel.startsWith("..")) {
      throw new Error(`Session ID path traversal detected: ${id}`)
    }
    return full
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.sessionsDir(), { recursive: true })
  }

  async load(id: string): Promise<SessionState | null> {
    const path = this.sessionPath(id)
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (readErr) {
      if (readErr instanceof Error && (readErr as NodeJS.ErrnoException).code === "ENOENT") {
        return null
      }
      this.onError(`[Session] Failed to read session file ${id}: ${readErr}`)
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Corrupt session file for ${id}: invalid JSON at ${path}`)
    }
    if (!validateSessionState(parsed)) {
      throw new Error(`Corrupt session file for ${id}: missing or invalid fields at ${path}`)
    }
    return parsed
  }

  async save(state: SessionState): Promise<void> {
    await this.ensureDir()
    const next: SessionState = structuredClone(state)
    next.updatedAt = new Date().toISOString()
    const path = this.sessionPath(state.id)
    const lockPath = lockPathFor(path)

    // Acquire exclusive lock before writing.
    const release = await acquireLock(lockPath, state.id)
    try {
      const tmpPath = `${path}.tmp`
      // Clean up any stale .tmp from a previous crash before writing.
      await rm(tmpPath, { force: true }).catch((err) => {
        this.onError(`[Session] Failed to clean up tmp file: ${err}`)
      })
      await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8")
      // Atomically rename to target path.
      await rename(tmpPath, path)
    } finally {
      await release()
    }
  }

  async delete(id: string): Promise<void> {
    const path = this.sessionPath(id)
    const lockPath = lockPathFor(path)

    // Acquire exclusive lock before deleting.
    const release = await acquireLock(lockPath, id)
    try {
      await rm(path, { force: true })
      const tmpPath = `${path}.tmp`
      // Clean up stale temp file if it exists after rename failed.
      await rm(tmpPath, { force: true }).catch((err) => {
        this.onError(`[Session] Failed to clean up tmp file: ${err}`)
      })
    } finally {
      // release() already deletes the lock file.
      await release()
    }
  }

  async list(): Promise<Array<{ id: string; updatedAt: string }>> {
    try {
      await this.ensureDir()
      const entries = await readdir(this.sessionsDir())
      const results: Array<{ id: string; updatedAt: string }> = []
      for (const entry of entries) {
        if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue
        const id = entry.slice(0, -5)
        try {
          const raw = await readFile(this.sessionPath(id), "utf8")
          const parsed: unknown = JSON.parse(raw)
          if (!validateSessionState(parsed)) continue
          results.push({ id, updatedAt: parsed.updatedAt })
        } catch {
          // Skip corrupt individually — one bad file shouldn't break the list.
        }
      }
      return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } catch (err) {
      this.onError(`[Session] Failed to list sessions: ${err}`)
      return []
    }
  }
}
