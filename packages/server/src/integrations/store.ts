/**
 * Session store factory — selects persistence backend from env/config.
 */

import type { SessionStore } from "@butterfly/session"
import { defaultSQLitePath, FileSystemSessionStore, SQLiteSessionStore } from "@butterfly/session"

export type SessionStoreBackend = "fs" | "sqlite"

export interface SessionStoreOptions {
  backend?: SessionStoreBackend
  sqlitePath?: string
}

/** Resolve session store backend from environment. */
export function resolveStoreBackend(
  env: Record<string, string | undefined> = process.env,
): SessionStoreBackend {
  const raw = (env.BUTTERFLY_SESSION_STORE ?? "fs").toLowerCase()
  return raw === "sqlite" ? "sqlite" : "fs"
}

/** Create a SessionStore for the given backend. */
export function createSessionStore(opts: SessionStoreOptions = {}): SessionStore {
  const backend = opts.backend ?? resolveStoreBackend()
  if (backend === "sqlite") {
    return new SQLiteSessionStore(opts.sqlitePath ?? defaultSQLitePath())
  }
  return new FileSystemSessionStore()
}
