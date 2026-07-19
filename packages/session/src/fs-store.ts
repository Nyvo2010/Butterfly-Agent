import { homedir } from "node:os"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { SessionState } from "./types"
import type { SessionStore } from "./store"

function globalSessionsDir(): string {
  return join(homedir(), ".butterfly", "sessions")
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
 */
export class FileSystemSessionStore implements SessionStore {
  private readonly root: string | null

  constructor(root?: string) {
    this.root = root ?? null
  }

  private sessionsDir(): string {
    return this.root ? join(this.root, ".butterfly", "sessions") : globalSessionsDir()
  }

  private sessionPath(id: string): string {
    return join(this.sessionsDir(), `${id}.json`)
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.sessionsDir(), { recursive: true })
  }

  async load(id: string): Promise<SessionState | null> {
    try {
      const raw = await readFile(this.sessionPath(id), "utf8")
      return JSON.parse(raw) as SessionState
    } catch {
      return null
    }
  }

  async save(state: SessionState): Promise<void> {
    if (!state.id) {
      throw new Error("FileSystemSessionStore.save: state.id is required")
    }
    await this.ensureDir()
    const next: SessionState = { ...state, updatedAt: new Date().toISOString() }
    await writeFile(this.sessionPath(state.id), JSON.stringify(next, null, 2), "utf8")
  }

  async list(): Promise<Array<{ id: string; updatedAt: string }>> {
    try {
      await this.ensureDir()
      const entries = await readdir(this.sessionsDir())
      const results: Array<{ id: string; updatedAt: string }> = []
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue
        const id = entry.slice(0, -5)
        try {
          const raw = await readFile(this.sessionPath(id), "utf8")
          const state = JSON.parse(raw) as SessionState
          results.push({ id, updatedAt: state.updatedAt })
        } catch {
          continue
        }
      }
      return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } catch {
      return []
    }
  }
}
