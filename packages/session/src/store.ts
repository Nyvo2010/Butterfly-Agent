import type { SessionState } from "./types"

export interface SessionStore {
  load(id: string): Promise<SessionState | null>
  save(state: SessionState): Promise<void> // keyed by state.id
  list(): Promise<Array<{ id: string; updatedAt: string }>>
  delete(id: string): Promise<void>
}

export class InMemorySessionStore implements SessionStore {
  private readonly map = new Map<string, SessionState>()

  async load(id: string): Promise<SessionState | null> {
    const state = this.map.get(id)
    if (!state) return null
    // Deep-clone so caller mutations don't corrupt stored state.
    return structuredClone(state)
  }

  async save(state: SessionState): Promise<void> {
    if (!state.id) {
      throw new Error("InMemorySessionStore.save: state.id is required")
    }
    // Deep-clone so stored state does not share array references with the caller.
    const next: SessionState = structuredClone(state)
    next.updatedAt = new Date().toISOString()
    this.map.set(state.id, next)
  }

  async list(): Promise<Array<{ id: string; updatedAt: string }>> {
    return Array.from(this.map.values())
      .map((s) => ({ id: s.id, updatedAt: s.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async delete(id: string): Promise<void> {
    this.map.delete(id)
  }
}
