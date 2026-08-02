/**
 * Permission request store — transient HITL state with a swappable backend.
 *
 * Default: in-memory Map (single process). Interface allows a Redis/SQLite
 * implementation later for horizontal scale + sticky-session-free deploys.
 */

import type { PermissionCategory } from "@butterfly/agent"

export interface PendingPermissionRecord {
  requestId: string
  sessionId: string
  tool: string
  category: PermissionCategory
  question: string
  options?: string[]
  createdAt: string
}

export interface PendingPermissionEntry extends PendingPermissionRecord {
  /** Resolve the pending request. Pass null to signal cancellation (run aborted). */
  resolve: (answer: string | null) => void
  timeout: ReturnType<typeof setTimeout>
}

export interface PermissionStore {
  set(entry: PendingPermissionEntry): void
  get(requestId: string): PendingPermissionEntry | undefined
  delete(requestId: string): boolean
  list(sessionId?: string): PendingPermissionRecord[]
  hasPendingForSession(sessionId: string): boolean
  /** Remove and time out every pending request for a session (run ended/aborted). */
  clearForSession(sessionId: string): void
  clear(): void
}

export class InMemoryPermissionStore implements PermissionStore {
  private readonly pending = new Map<string, PendingPermissionEntry>()

  set(entry: PendingPermissionEntry): void {
    this.pending.set(entry.requestId, entry)
  }

  get(requestId: string): PendingPermissionEntry | undefined {
    return this.pending.get(requestId)
  }

  delete(requestId: string): boolean {
    return this.pending.delete(requestId)
  }

  list(sessionId?: string): PendingPermissionRecord[] {
    const all = Array.from(this.pending.values())
    const filtered = sessionId ? all.filter((p) => p.sessionId === sessionId) : all
    return filtered.map(({ resolve: _, timeout: __, ...record }) => record)
  }

  hasPendingForSession(sessionId: string): boolean {
    for (const p of this.pending.values()) {
      if (p.sessionId === sessionId) return true
    }
    return false
  }

  clearForSession(sessionId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue
      clearTimeout(entry.timeout)
      entry.resolve(null) // signals cancellation to the awaiting tool
      this.pending.delete(requestId)
    }
  }

  clear(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout)
    }
    this.pending.clear()
  }
}
