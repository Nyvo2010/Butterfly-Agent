import type { SessionState } from "./types"

export interface SessionStore {
  load(id: string): Promise<SessionState | null>
  save(state: SessionState): Promise<void> // keyed by state.id
  list(): Promise<Array<{ id: string; updatedAt: string }>>
}

export class InMemorySessionStore implements SessionStore {
  private readonly map = new Map<string, SessionState>()

  async load(id: string): Promise<SessionState | null> {
    return this.map.get(id) ?? null
  }

  async save(state: SessionState): Promise<void> {
    if (!state.id) {
      throw new Error("InMemorySessionStore.save: state.id is required")
    }
    const next: SessionState = { ...state, updatedAt: new Date().toISOString() }
    this.map.set(state.id, next)
  }

  async list(): Promise<Array<{ id: string; updatedAt: string }>> {
    return Array.from(this.map.values())
      .map((s) => ({ id: s.id, updatedAt: s.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}
