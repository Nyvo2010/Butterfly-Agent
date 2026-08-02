import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { SessionStore } from "./store"
import type { SessionState } from "./types"

// better-sqlite3 is an optional dependency. The store will throw
// a clear error at construction time if it's not installed.
// Uses a typed interface to avoid @ts-expect-error throughout.

interface SQLiteDB {
  pragma(s: string): void
  exec(sql: string): void
  prepare(sql: string): SQLiteStatement
  close(): void
  checkpoint(): void
}

interface SQLiteStatement {
  run(...args: unknown[]): { changes: number }
  get(...args: unknown[]): unknown
  all(...args: unknown[]): unknown[]
}

interface SQLiteConstructor {
  new (path: string, options?: { readonly?: boolean; timeout?: number }): SQLiteDB
}

let DBCtor: SQLiteConstructor | null = null

async function loadDBCtor(): Promise<SQLiteConstructor> {
  if (DBCtor) return DBCtor
  try {
    // @ts-expect-error - optional dependency, may not be installed
    const mod = (await import("better-sqlite3").catch(() => null)) as {
      default?: SQLiteConstructor
    } | null
    const Ctor = mod?.default ?? (mod as unknown as SQLiteConstructor | null)
    if (typeof Ctor !== "function") {
      throw new Error("better-sqlite3 module did not export a constructor")
    }
    DBCtor = Ctor
    return Ctor
  } catch (err) {
    if (err instanceof Error && err.message.includes("did not export")) throw err
    throw new Error(
      "SQLiteSessionStore requires better-sqlite3. Install it with: pnpm add better-sqlite3, " +
        "then remove the @ts-expect-error directive above the import.\n" +
        `Original error: ${(err as Error).message}`,
    )
  }
}

/** Default path for the SQLite database. */
export function defaultSQLitePath(): string {
  return join(homedir(), ".butterfly", "sessions.db")
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  data JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
`

/**
 * Run schema migrations for the SQLite session store.
 * Each migration is a numbered step. Add new migrations at the end
 * with an incremented version number. Migrations are idempotent (IF NOT EXISTS).
 */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  // v1: Initial schema — sessions table + updated_at index.
  { version: 1, sql: SCHEMA_SQL },
]

function runMigrations(db: SQLiteDB): void {
  // Ensure schema_version table exists (created in SCHEMA_SQL for fresh DBs,
  // but may be missing on very old databases).
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)")

  const currentVersion =
    (
      db.prepare("SELECT MAX(version) as v FROM schema_version").get() as
        | { v: number | null }
        | undefined
    )?.v ?? 0

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.exec(migration.sql)
      db.prepare("INSERT OR REPLACE INTO schema_version (version) VALUES (?)").run(
        migration.version,
      )
    }
  }
}

export class SQLiteSessionStore implements SessionStore {
  private db: SQLiteDB | null = null
  private initialized = false
  private readonly dbPath: string
  private readonly onError: (msg: string) => void

  constructor(dbPath?: string, onError?: (msg: string) => void) {
    this.onError = onError ?? ((msg) => console.error(msg))
    this.dbPath = dbPath ?? defaultSQLitePath()
  }

  private async ensureInit(): Promise<SQLiteDB> {
    if (this.initialized && this.db) return this.db
    const Ctor = await loadDBCtor()
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true })
    } catch {
      // Directory may already exist.
    }
    this.db = new Ctor(this.dbPath, { timeout: 5000 })
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("foreign_keys = ON")
    runMigrations(this.db)
    this.initialized = true
    return this.db
  }

  async load(id: string): Promise<SessionState | null> {
    try {
      const db = await this.ensureInit()
      const stmt = db.prepare("SELECT data FROM sessions WHERE id = ?")
      const row = stmt.get(id) as { data: string } | undefined
      if (!row) return null
      const parsed = JSON.parse(row.data)
      // Validate that the parsed data looks like a valid SessionState.
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.id !== "string" ||
        typeof parsed.mode !== "string" ||
        !Array.isArray(parsed.messages)
      ) {
        this.onError(`[SQLiteStore] Corrupt session data for ${id}`)
        return null
      }
      return parsed as SessionState
    } catch (err) {
      this.onError(`[SQLiteStore] Failed to load session ${id}: ${err}`)
      return null
    }
  }

  async save(state: SessionState): Promise<void> {
    if (!state.id) {
      throw new Error("SQLiteSessionStore.save: state.id is required")
    }
    try {
      // Guard against excessively large sessions that could OOM or
      // produce multi-MB JSON blobs. 50MB is a generous ceiling for
      // long-running sessions with many tool calls.
      const MAX_SESSION_JSON_BYTES = 50 * 1024 * 1024
      const now = new Date().toISOString()
      // Sync updatedAt in both the JSON blob and the DB column.
      const synced = { ...state, updatedAt: now }
      const serialized = JSON.stringify(synced)
      if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_JSON_BYTES) {
        throw new Error(
          `Session ${state.id} exceeds ${MAX_SESSION_JSON_BYTES / (1024 * 1024)}MB limit. ` +
            `Consider starting a new session.`,
        )
      }
      const db = await this.ensureInit()
      const stmt = db.prepare(
        "INSERT OR REPLACE INTO sessions (id, data, updated_at) VALUES (?, ?, ?)",
      )
      stmt.run(synced.id, serialized, now)
    } catch (err) {
      this.onError(`[SQLiteStore] Failed to save session ${state.id}: ${err}`)
      throw err
    }
  }

  async list(): Promise<Array<{ id: string; updatedAt: string }>> {
    try {
      const db = await this.ensureInit()
      const stmt = db.prepare("SELECT id, updated_at FROM sessions ORDER BY updated_at DESC")
      const rows = stmt.all() as Array<{ id: string; updated_at: string }>
      return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at }))
    } catch (err) {
      this.onError(`[SQLiteStore] Failed to list sessions: ${err}`)
      return []
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const db = await this.ensureInit()
      const stmt = db.prepare("DELETE FROM sessions WHERE id = ?")
      stmt.run(id)
    } catch (err) {
      this.onError(`[SQLiteStore] Failed to delete session ${id}: ${err}`)
    }
  }

  /**
   * Close the database connection after running a WAL checkpoint.
   * Safe to call multiple times.
   */
  close(): void {
    try {
      if (this.db) {
        // Run WAL checkpoint to truncate the WAL file before closing.
        try {
          this.db.pragma("wal_checkpoint(TRUNCATE)")
        } catch {
          // Checkpoint is best-effort.
        }
        this.db.close()
        this.db = null
        this.initialized = false
      }
    } catch {
      // Already closed.
    }
  }
}
