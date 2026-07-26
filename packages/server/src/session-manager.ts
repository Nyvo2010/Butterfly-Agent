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
import type { Mode, SessionState, SessionStore, SessionUsage, Tier } from "@butterfly/session"
import { createSession, zeroUsage } from "@butterfly/session"
import type { EventBus } from "./bus"

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
   */
  async save(session: SessionState): Promise<void> {
    const toSave: SessionState = {
      ...session,
      title: session.title ?? deriveTitle(session),
      updatedAt: new Date().toISOString(),
    }
    await this.store.save(toSave)
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
}
