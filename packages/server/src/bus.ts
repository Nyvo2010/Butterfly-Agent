/**
 * Butterfly Event Bus — a decoupled publish/subscribe system for the server.
 *
 * Inspired by OpenCode's `bus/global.ts` GlobalBus, but with Butterfly-specific
 * typed event payloads. The server's agent loop publishes events; any number of
 * subscribers (HTTP /event SSE clients, the ACP layer, plugins, loggers) receive
 * them without coupling to the loop directly.
 *
 * Design:
 *   - EventEmitter-based singleton (process-scoped)
 *   - Single `event` channel with a typed `ButterflyEvent` union payload
 *   - Each event payload is assigned a unique ascending id when missing
 *   - No persistence: events are fire-and-forget (the SessionStore is the
 *     source of truth for recoverable state)
 *
 * This is what makes the client/server split work: the client subscribes to the
 * global event stream and renders whatever arrives. The server does not need to
 * know anything about connected clients.
 */

import { EventEmitter } from "node:events"

// ─── Event types ──────────────────────────────────────────────────────────────

/** Session lifecycle event kinds. */
export type SessionEventKind =
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "session.archived"
  | "session.forked"

/** Run (agent loop execution) lifecycle event kinds. */
export type RunEventKind = "run.started" | "run.completed" | "run.aborted" | "run.error"

/** Streaming token deltas, assistant reasoning, and per-call usage. */
export type StreamEventKind = "stream.text_delta" | "stream.reasoning" | "stream.usage"

/** Tool execution event kinds. */
export type ToolEventKind = "tool.start" | "tool.result" | "tool.error"

/** File change event kinds. */
export type FileEventKind = "file.changed"

/** Permission request event kinds (human-in-the-loop). */
export type PermissionEventKind = "permission.requested" | "permission.resolved"

/** MCP server lifecycle. */
export type MCPEventKind = "mcp.connected" | "mcp.disconnected" | "mcp.error"

/** The full union of event kinds. */
export type ButterflyEventKind =
  | SessionEventKind
  | RunEventKind
  | StreamEventKind
  | ToolEventKind
  | FileEventKind
  | PermissionEventKind
  | MCPEventKind

// ─── Event payloads ───────────────────────────────────────────────────────────

/**
 * Discriminated union of all Butterfly events.
 * `kind` identifies the event; `type` is the category grouping.
 * The `id` field is auto-assigned by the bus when not provided.
 */
export interface ButterflyEventBase {
  /** Unique ascending event id (assigned by the bus when missing). */
  id: string
  /** The specific event kind. */
  kind: ButterflyEventKind
  /** Event category (session | run | stream | tool | file | permission | mcp). */
  type: (typeof EVENT_CATEGORIES)[ButterflyEventKind]
  /** ISO 8601 timestamp. */
  timestamp: string
  /** Session this event belongs to (when applicable). */
  sessionId?: string
}

export interface SessionCreatedEvent extends ButterflyEventBase {
  kind: "session.created"
  sessionId: string
  data: { mode: string; title: string }
}
export interface SessionUpdatedEvent extends ButterflyEventBase {
  kind: "session.updated"
  sessionId: string
  data: { fields: string[] }
}
export interface SessionDeletedEvent extends ButterflyEventBase {
  kind: "session.deleted"
  sessionId: string
}
export interface SessionArchivedEvent extends ButterflyEventBase {
  kind: "session.archived"
  sessionId: string
  data: { archived: boolean }
}
export interface SessionForkedEvent extends ButterflyEventBase {
  kind: "session.forked"
  sessionId: string
  data: { parentSessionId: string }
}

export interface RunStartedEvent extends ButterflyEventBase {
  kind: "run.started"
  sessionId: string
  data: { query: string; model: string; tier: string }
}
export interface RunCompletedEvent extends ButterflyEventBase {
  kind: "run.completed"
  sessionId: string
  data: {
    iterations: number
    stopReason: string
    model: string
    tier: string
  }
}
export interface RunAbortedEvent extends ButterflyEventBase {
  kind: "run.aborted"
  sessionId: string
}
export interface RunErrorEvent extends ButterflyEventBase {
  kind: "run.error"
  sessionId: string
  data: { message: string }
}

export interface StreamTextDeltaEvent extends ButterflyEventBase {
  kind: "stream.text_delta"
  sessionId: string
  data: { text: string }
}
export interface StreamReasoningEvent extends ButterflyEventBase {
  kind: "stream.reasoning"
  sessionId: string
  data: { text: string }
}
export interface StreamUsageEvent extends ButterflyEventBase {
  kind: "stream.usage"
  sessionId: string
  data: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export interface ToolStartEvent extends ButterflyEventBase {
  kind: "tool.start"
  sessionId: string
  data: { tool: string; input: unknown }
}
export interface ToolResultEvent extends ButterflyEventBase {
  kind: "tool.result"
  sessionId: string
  data: { tool: string; error?: string }
}
export interface ToolErrorEvent extends ButterflyEventBase {
  kind: "tool.error"
  sessionId: string
  data: { tool: string; message: string }
}

export interface FileChangedEvent extends ButterflyEventBase {
  kind: "file.changed"
  sessionId: string
  data: { path: string; changeKind: string }
}

export interface PermissionRequestedEvent extends ButterflyEventBase {
  kind: "permission.requested"
  sessionId: string
  data: { requestId: string; tool: string; question: string; options?: string[] }
}
export interface PermissionResolvedEvent extends ButterflyEventBase {
  kind: "permission.resolved"
  sessionId: string
  data: { requestId: string; allowed: boolean }
}

export interface MCPConnectedEvent extends ButterflyEventBase {
  kind: "mcp.connected"
  data: { server: string; toolCount: number }
}
export interface MCPDisconnectedEvent extends ButterflyEventBase {
  kind: "mcp.disconnected"
  data: { server: string }
}
export interface MCPErrorEvent extends ButterflyEventBase {
  kind: "mcp.error"
  data: { server: string; message: string }
}

/** The full discriminated union of all Butterfly events. */
export type ButterflyEvent =
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionDeletedEvent
  | SessionArchivedEvent
  | SessionForkedEvent
  | RunStartedEvent
  | RunCompletedEvent
  | RunAbortedEvent
  | RunErrorEvent
  | StreamTextDeltaEvent
  | StreamReasoningEvent
  | StreamUsageEvent
  | ToolStartEvent
  | ToolResultEvent
  | ToolErrorEvent
  | FileChangedEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | MCPConnectedEvent
  | MCPDisconnectedEvent
  | MCPErrorEvent

/** Event category mapping (kind → category). */
export const EVENT_CATEGORIES = {
  "session.created": "session",
  "session.updated": "session",
  "session.deleted": "session",
  "session.archived": "session",
  "session.forked": "session",
  "run.started": "run",
  "run.completed": "run",
  "run.aborted": "run",
  "run.error": "run",
  "stream.text_delta": "stream",
  "stream.reasoning": "stream",
  "stream.usage": "stream",
  "tool.start": "tool",
  "tool.result": "tool",
  "tool.error": "tool",
  "file.changed": "file",
  "permission.requested": "permission",
  "permission.resolved": "permission",
  "mcp.connected": "mcp",
  "mcp.disconnected": "mcp",
  "mcp.error": "mcp",
} as const satisfies Record<ButterflyEventKind, string>

// ─── Id generator ─────────────────────────────────────────────────────────────

let eventCounter = 0

/** Generate a monotonically increasing event id. */
function nextEventId(): string {
  eventCounter += 1
  return `evt-${eventCounter}`
}

/** Reset the event id counter (testing only). */
export function _resetEventIdCounter(): void {
  eventCounter = 0
}

// ─── Event Bus ────────────────────────────────────────────────────────────────

/**
 * Butterfly event bus — a typed EventEmitter wrapper.
 *
 * Mirrors OpenCode's GlobalBus pattern: a single `event` channel carrying
 * typed `ButterflyEvent` payloads. Auto-assigns `id` and `timestamp` when the
 * publisher does not provide them.
 */
export class EventBus {
  private readonly emitter = new EventEmitter<{ event: [ButterflyEvent] }>()
  /** Max listeners — bumped high enough for many SSE clients per process. */
  private readonly maxListeners = 200

  constructor() {
    this.emitter.setMaxListeners(this.maxListeners)
  }

  /**
   * Publish an event. The `id`, `timestamp`, and `type` are auto-filled.
   * The caller provides `kind`, optional `sessionId`, and optional `data`.
   *
   * `type` (the category) is derived from `kind` via EVENT_CATEGORIES so callers
   * never need to pass it — eliminating a redundant and error-prone field.
   *
   * The input type is intentionally loose (a structural shape) rather than the
   * full discriminated union: TypeScript cannot infer which union member an
   * object literal matches when `data` is a generic `Record<string, unknown>`.
   * The cast to `ButterflyEvent` is safe because `kind`/`type`/`sessionId`/
   * `data` are the only fields the union members use.
   */
  emit(event: {
    kind: ButterflyEventKind
    sessionId?: string
    data?: Record<string, unknown>
    id?: string
    timestamp?: string
  }): void {
    const full = {
      ...event,
      type: EVENT_CATEGORIES[event.kind],
      id: event.id ?? nextEventId(),
      timestamp: event.timestamp ?? new Date().toISOString(),
    } as ButterflyEvent
    this.emitter.emit("event", full)
  }

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(handler: (event: ButterflyEvent) => void): () => void {
    this.emitter.on("event", handler)
    return () => {
      this.emitter.off("event", handler)
    }
  }

  /**
   * Subscribe to events filtered by kind(s).
   * Returns an unsubscribe function.
   */
  subscribeTo(
    kinds: ButterflyEventKind | ButterflyEventKind[],
    handler: (event: ButterflyEvent) => void,
  ): () => void {
    const set = new Set(Array.isArray(kinds) ? kinds : [kinds])
    const wrapped = (event: ButterflyEvent) => {
      if (set.has(event.kind)) handler(event)
    }
    this.emitter.on("event", wrapped)
    return () => {
      this.emitter.off("event", wrapped)
    }
  }

  /**
   * Subscribe to events for a specific session.
   * Returns an unsubscribe function.
   */
  subscribeToSession(sessionId: string, handler: (event: ButterflyEvent) => void): () => void {
    const wrapped = (event: ButterflyEvent) => {
      if (event.sessionId === sessionId) handler(event)
    }
    this.emitter.on("event", wrapped)
    return () => {
      this.emitter.off("event", wrapped)
    }
  }

  /** Remove all listeners (used in tests and on shutdown). */
  clear(): void {
    this.emitter.removeAllListeners("event")
  }

  /** Current listener count (diagnostics). */
  listenerCount(): number {
    return this.emitter.listenerCount("event")
  }
}
