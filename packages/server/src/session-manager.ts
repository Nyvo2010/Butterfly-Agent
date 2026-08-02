/**
 * Session Manager — wraps SessionStore with higher-level operations.
 *
 * Inspired by OpenCode's session/ session.ts service layer: the store is just
 * persistence; the manager adds derived fields (title, summary, usage) and
 * operations (fork, archive, update) that the client-facing API needs.
 *
 * Responsibilities:
 *   - Auto-derive a session title from the first user message
 *   - Accumulate LLM usage into session state across calls
 *   - Fork a session (deep copy with a new id + parentSessionId)
 *   - Generate a short summary from the latest assistant messages
 *   - Update metadata (mode, tier, title, archived) and persist
 *
 * Emits session.* events on the bus for each mutation.
 */

import { randomUUID } from "node:crypto"
import { log } from "@butterfly/core"
import type { LLMUsage } from "@butterfly/llm"
import type {
  Mode,
  SessionMessage,
  SessionState,
  SessionStore,
  SessionUsage,
  Tier,
} from "@butterfly/session"
import { createSession, zeroUsage } from "@butterfly/session"
import type { EventBus } from "./bus"
import { emitNewMessages } from "./message-events"

/** Schema version for exported session JSON. Bump on breaking format changes. */
export const SESSION_EXPORT_VERSION = 1

export interface SessionExport {
  /** Export schema version. */
  schemaVersion: number
  /** Export timestamp (ISO 8601). */
  exportedAt: string
  /** Original session id. */
  sessionId: string
  /** The full session state. */
  session: SessionState
}

export interface SessionSearchResult {
  id: string
  title: string
  summary?: string
  updatedAt: string
  /** Message snippets that matched the query. */
  matches: Array<{ role: string; content: string }>
}

const MAX_TITLE_LENGTH = 80
const MAX_SUMMARY_LENGTH = 200

export interface CreateSessionOptions {
  mode?: Mode
  tier?: Tier
  title?: string
  /** Explicit session id (defaults to a generated uuid). */
  id?: string
  /** Selected model for this session ("auto" or a specific model string). */
  selectedModel?: string
}

export interface UpdateSessionFields {
  mode?: Mode
  tier?: Tier
  title?: string
  summary?: string
  archived?: boolean
  /** Selected model for this session ("auto" or a specific model string). */
  selectedModel?: string
}

/**
 * Derive a human-readable title from the first user message.
 * Returns the first non-empty user message, truncated.
 */
export function deriveTitle(session: SessionState): string {
  const firstUser = session.messages.find((m) => m.role === "user")
  if (!firstUser) return "New session"
  const content = firstUser.content.replace(/\[Project context:[^\]]*\]\s*/g, "").trim()
  if (!content) return "New session"
  const firstLine = content.split("\n")[0]?.trim() ?? content
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine
  return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…`
}

/**
 * Accumulate a new LLM usage report into the session's running totals.
 * Returns a new SessionState (does not mutate the input).
 */
export function accumulateUsage(session: SessionState, usage: LLMUsage): SessionState {
  const current: SessionUsage = session.usage ?? zeroUsage()
  const next: SessionUsage = {
    promptTokens: current.promptTokens + usage.promptTokens,
    completionTokens: current.completionTokens + usage.completionTokens,
    totalTokens: current.totalTokens + usage.totalTokens,
    usageAvailable: current.usageAvailable || usage.usageAvailable,
    callCount: current.callCount + 1,
    // Preserve the accumulated cost (may be undefined if pricing is unknown).
    costUsd: current.costUsd,
  }
  return { ...session, usage: next, updatedAt: new Date().toISOString() }
}

/**
 * Generate a short summary from the latest assistant messages.
 * This is a heuristic summary (no LLM call) — good enough for session lists.
 */
export function generateSummary(session: SessionState): string {
  const assistantMsgs = session.messages.filter((m) => m.role === "assistant")
  if (assistantMsgs.length === 0) return ""
  const last = assistantMsgs[assistantMsgs.length - 1]
  const content = last.content.trim()
  if (!content) return ""
  if (content.length <= MAX_SUMMARY_LENGTH) return content
  return `${content.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
}

export class SessionManager {
  constructor(
    private readonly store: SessionStore,
    private readonly bus: EventBus,
  ) {}

  /** Create a new session, persist it, and emit a created event. */
  async create(opts: CreateSessionOptions = {}): Promise<SessionState> {
    const id = opts.id ?? `s-${randomUUID()}`
    const session = createSession(id, opts.mode ?? "build", opts.tier ?? "standard")
    if (opts.title) session.title = opts.title
    if (opts.selectedModel) session.selectedModel = opts.selectedModel
    await this.store.save(session)
    this.bus.emit({
      kind: "session.created",
      sessionId: session.id,
      data: { mode: session.mode, title: session.title ?? "New session" },
    })
    log("info", "session_manager.create", { sessionId: session.id, mode: session.mode })
    return session
  }

  /** Load a session by id. */
  async load(id: string): Promise<SessionState | null> {
    return this.store.load(id)
  }

  /** List sessions, optionally excluding archived ones. */
  async list(includeArchived = false): Promise<Array<{ id: string; updatedAt: string }>> {
    const all = await this.store.list()
    if (includeArchived) return all
    // Filter archived sessions lazily — only load to check the archived flag.
    const result: Array<{ id: string; updatedAt: string }> = []
    for (const entry of all) {
      const session = await this.store.load(entry.id)
      if (session && !session.archived) {
        result.push(entry)
      }
    }
    return result
  }

  /** Delete a session and emit a deleted event. */
  async delete(id: string): Promise<void> {
    await this.store.delete(id)
    this.bus.emit({ kind: "session.deleted", sessionId: id })
    log("info", "session_manager.delete", { sessionId: id })
  }

  /** Update session metadata fields and persist. */
  async update(id: string, fields: UpdateSessionFields): Promise<SessionState | null> {
    const session = await this.store.load(id)
    if (!session) return null
    const updated: SessionState = {
      ...session,
      ...(fields.mode !== undefined ? { mode: fields.mode } : {}),
      ...(fields.tier !== undefined ? { tier: fields.tier } : {}),
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
      ...(fields.archived !== undefined ? { archived: fields.archived } : {}),
      ...(fields.selectedModel !== undefined ? { selectedModel: fields.selectedModel } : {}),
      updatedAt: new Date().toISOString(),
    }
    await this.store.save(updated)
    this.bus.emit({
      kind: "session.updated",
      sessionId: id,
      data: { fields: Object.keys(fields) },
    })
    return updated
  }

  /** Archive/unarchive a session. */
  async archive(id: string, archived = true): Promise<SessionState | null> {
    const updated = await this.update(id, { archived })
    if (updated) {
      this.bus.emit({
        kind: "session.archived",
        sessionId: id,
        data: { archived },
      })
    }
    return updated
  }

  /**
   * Fork a session — create a deep copy with a new id and parentSessionId.
   * The fork shares the message history up to the fork point but diverges after.
   */
  async fork(parentId: string): Promise<SessionState | null> {
    const parent = await this.store.load(parentId)
    if (!parent) return null
    const forkId = `s-${randomUUID()}`
    const forked: SessionState = {
      ...structuredClone(parent),
      id: forkId,
      parentSessionId: parentId,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usage: parent.usage ?? zeroUsage(),
    }
    await this.store.save(forked)
    this.bus.emit({
      kind: "session.forked",
      sessionId: forkId,
      data: { parentSessionId: parentId },
    })
    log("info", "session_manager.fork", { forkId, parentId })
    return forked
  }

  /**
   * Persist an updated session (e.g. after the agent loop ran).
   * Auto-derives a title if none is set.
   * Emits message.added for any new messages when `previousMessageCount` is set.
   */
  async save(session: SessionState, opts?: { previousMessageCount?: number }): Promise<void> {
    const prevCount = opts?.previousMessageCount ?? session.messages.length
    const toSave: SessionState = {
      ...session,
      title: session.title ?? deriveTitle(session),
      updatedAt: new Date().toISOString(),
    }
    await this.store.save(toSave)
    emitNewMessages(this.bus, toSave.id, toSave.messages, prevCount)
  }

  /**
   * Summarize a session on demand — generates a heuristic summary and persists it.
   */
  async summarize(id: string): Promise<SessionState | null> {
    const session = await this.store.load(id)
    if (!session) return null
    const summary = generateSummary(session)
    return this.update(id, { summary })
  }

  /**
   * Export a session as portable JSON (for sharing / backup / migration).
   */
  async export(id: string): Promise<SessionExport | null> {
    const session = await this.store.load(id)
    if (!session) return null
    return {
      schemaVersion: SESSION_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      sessionId: session.id,
      session,
    }
  }

  /**
   * Import a session from exported JSON. Creates a NEW session (fresh id) so
   * importing never overwrites existing data. Accepts either a raw SessionExport
   * (schemaVersion >= 1) or a bare SessionState.
   */
  async import(data: unknown): Promise<SessionState | null> {
    const session = coerceImportedSession(data)
    if (!session) return null
    const newId = `s-${randomUUID()}`
    const imported: SessionState = {
      ...session,
      id: newId,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usage: session.usage ?? zeroUsage(),
    }
    await this.store.save(imported)
    this.bus.emit({
      kind: "session.imported",
      sessionId: newId,
      data: { sourceId: session.id, messageCount: imported.messages.length },
    })
    log("info", "session_manager.import", { newId, sourceId: session.id })
    return imported
  }

  /**
   * Search sessions by title, summary, and message content.
   * Returns sessions with matching message snippets, newest first.
   */
  async search(query: string, limit = 20): Promise<SessionSearchResult[]> {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const entries = await this.store.list()
    const results: SessionSearchResult[] = []
    for (const entry of entries) {
      const session = await this.store.load(entry.id)
      if (!session) continue
      const title = (session.title ?? "").toLowerCase()
      const summary = (session.summary ?? "").toLowerCase()
      const titleOrSummaryHit = title.includes(q) || summary.includes(q)
      const matches: Array<{ role: string; content: string }> = []
      for (const m of session.messages) {
        const content = String(m.content)
        const idx = content.toLowerCase().indexOf(q)
        if (idx !== -1) {
          // Extract a short snippet around the match.
          const start = Math.max(0, idx - 40)
          const snippet = (start > 0 ? "…" : "") + content.slice(start, idx + q.length + 80)
          matches.push({ role: m.role, content: snippet })
        }
      }
      if (titleOrSummaryHit || matches.length > 0) {
        results.push({
          id: session.id,
          title: session.title ?? "Untitled",
          summary: session.summary,
          updatedAt: session.updatedAt,
          matches: matches.slice(0, 5),
        })
      }
      if (results.length >= limit) break
    }
    return results
  }

  /**
   * Edit the content of a single message. Preserves id, role, timestamps.
   * Returns the updated session, or null if the session/message doesn't exist.
   */
  async editMessage(id: string, messageId: string, content: string): Promise<SessionState | null> {
    const session = await this.store.load(id)
    if (!session) return null
    const idx = session.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return null
    // Only user/assistant text messages are editable. Editing tool messages
    // would corrupt tool-call pairing for COE truncation and LLM validation.
    const msg = session.messages[idx]
    if (msg.role !== "user" && msg.role !== "assistant") return null

    const messages = session.messages.map((m, i) => {
      if (i !== idx) return m
      // Update both the plain-text content and any text part, keeping role/id.
      const parts = m.parts?.map((p) => (p.type === "text" ? { ...p, text: content } : p))
      return { ...m, content, parts } as SessionMessage
    })

    const updated: SessionState = {
      ...session,
      messages,
      updatedAt: new Date().toISOString(),
    }
    await this.store.save(updated)
    this.bus.emit({
      kind: "session.updated",
      sessionId: id,
      data: { fields: ["messages"] },
    })
    this.bus.emit({
      kind: "message.updated",
      sessionId: id,
      data: { messageId, content },
    })
    return updated
  }

  /**
   * Prepare a retry: truncate the session back to (and including) the last
   * user message, so the loop can re-run from there. Returns the query to
   * re-send, or null when no user message exists.
   */
  async retry(id: string): Promise<{ query: string } | null> {
    const session = await this.store.load(id)
    if (!session) return null
    const lastUserIdx = session.messages.reduce((acc, m, i) => (m.role === "user" ? i : acc), -1)
    if (lastUserIdx === -1) return null

    const kept = session.messages.slice(0, lastUserIdx + 1)
    // The messages truncated away are the assistant/tool turns after the last
    // user message — emit message.removed per message so clients drop them.
    const removed = session.messages.slice(lastUserIdx + 1)
    const query = String(kept[kept.length - 1].content).replace(
      /^\[Project context:[^\]]*\]\s*/,
      "",
    )
    const updated: SessionState = {
      ...session,
      messages: kept,
      updatedAt: new Date().toISOString(),
    }
    await this.store.save(updated)
    this.bus.emit({ kind: "session.updated", sessionId: id, data: { fields: ["messages"] } })
    for (const m of removed) {
      this.bus.emit({
        kind: "message.removed",
        sessionId: id,
        data: { messageId: m.id, count: removed.length },
      })
    }
    return { query }
  }
}

/**
 * Validate + coerce an imported payload into a SessionState.
 * Accepts a SessionExport envelope or a bare session object.
 * Returns null on invalid input.
 */
function coerceImportedSession(data: unknown): SessionState | null {
  if (typeof data !== "object" || data === null) return null
  const raw = data as Record<string, unknown>
  const session = (raw.session ?? raw) as Record<string, unknown> | undefined
  if (typeof session !== "object" || session === null) return null

  if (typeof session.id !== "string" || !session.id) return null
  if (session.mode !== "plan" && session.mode !== "build") return null
  if (
    session.tier !== "trivial" &&
    session.tier !== "standard" &&
    session.tier !== "complex" &&
    session.tier !== "escalate"
  ) {
    return null
  }
  if (!Array.isArray(session.messages)) return null
  if (!Array.isArray(session.toolCalls)) session.toolCalls = []
  if (!Array.isArray(session.fileChanges)) session.fileChanges = []
  if (!Array.isArray(session.readFiles)) session.readFiles = []
  if (typeof session.startedAt !== "string") session.startedAt = new Date().toISOString()
  if (typeof session.updatedAt !== "string") session.updatedAt = new Date().toISOString()

  return session as unknown as SessionState
}
