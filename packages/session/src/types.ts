// Session state types. No deduplication (COE handles that). No sticky-tier/escalation
// counters (those are Model Router runtime concerns, not session persistence).
// All timestamp fields are ISO 8601 strings — downstream should validate.

export type Role = "user" | "assistant" | "tool" | "system"
export type Mode = "plan" | "build"
export type Tier = "trivial" | "standard" | "complex" | "escalate"

/**
 * Structured message part — mirrors OpenCode's granular message parts.
 * Each message can consist of multiple parts: text, reasoning, tool calls.
 */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; output: unknown }

export interface UserOrSystemMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  /** Structured parts for granular message representation (OpenCode-compatible).
   * When present, `parts` takes precedence for rendering; `content` is the
   * canonical plain-text serialization used by COE and LLM calls. */
  parts?: MessagePart[]
  timestamp: string
  /** Optional tool call correlation ID for assistant messages. Set by the agent
   * loop when the assistant emits tool calls, so COE can group tool messages
   * with their parent assistant message without relying on string patterns. */
  toolCallId?: string
}

export interface ToolMessage {
  id: string
  role: "tool"
  content: string
  /** Structured parts for tool results (OpenCode-compatible). */
  parts?: MessagePart[]
  toolCallId: string
  timestamp: string
}

export type SessionMessage = UserOrSystemMessage | ToolMessage

export interface ToolCallRecord {
  id: string
  name: string
  input: unknown
  result?: unknown
  error?: string
  startedAt: string
  finishedAt?: string
}

/**
 * Accumulated token/cost usage for a session.
 * Summed across all LLM calls. Mirrors OpenCode's per-session cost tracking so
 * the client can render session lists with token/cost summaries without loading
 * full message history.
 */
export interface SessionUsage {
  /** Total prompt tokens across all LLM calls. */
  promptTokens: number
  /** Total completion tokens across all LLM calls. */
  completionTokens: number
  /** Total tokens (prompt + completion). */
  totalTokens: number
  /** Whether any provider-reported usage has been recorded. */
  usageAvailable: boolean
  /** Number of LLM calls made. */
  callCount: number
  /**
   * Estimated total cost in USD, accumulated across all LLM calls.
   * Computed from the model's catalog pricing (per-1M-token input/output).
   * Undefined when pricing is unknown for the model(s) used.
   */
  costUsd?: number
}

export interface FileChange {
  path: string
  kind: "write" | "patch" | "delete"
  before?: string
  after?: string
  at: string
}

export interface SessionState {
  id: string
  mode: Mode
  tier: Tier
  messages: SessionMessage[]
  toolCalls: ToolCallRecord[]
  fileChanges: FileChange[]
  readFiles: string[]
  /** Git snapshot hashes keyed by iteration number. Maps iteration → tree hash.
   * Mirrors OpenCode's snapshot system for session revert support. */
  snapshots?: Record<number, string>
  startedAt: string
  updatedAt: string
  /** Human-readable title. Auto-derived from the first user message when not set. */
  title?: string
  /** Short summary of the session, generated on demand. */
  summary?: string
  /** Accumulated token usage across all LLM calls. */
  usage?: SessionUsage
  /** Parent session id if this session was forked from another. */
  parentSessionId?: string
  /** Whether the session is archived (hidden from default lists). */
  archived?: boolean
  /**
   * Selected model for this session. When "auto" (default), the tiered model
   * mapping from butterfly config is used. When set to a specific model
   * (e.g., "anthropic/claude-sonnet-4-5"), that model is used for ALL tiers
   * (no escalation to different models). Users can always choose a model
   * from the available provider catalog. Mirrors OpenCode's per-session
   * model selection.
   */
  selectedModel?: string
  /**
   * Active todo list for the session. Persisted alongside the session so
   * todos survive restarts. Updated by the todowrite tool.
   */
  todos?: import("./todo").TodoItem[]
  /**
   * Active-run marker — persisted so a crashed/restarted server can detect
   * interrupted runs and report an honest status instead of "running" forever.
   * Set when a run starts, cleared when it completes/aborts/errors.
   */
  activeRun?: {
    startedAt: string
    query?: string
    model?: string
    tier?: string
  }
}

/** Default (zeroed) session usage. */
export function zeroUsage(): SessionUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    usageAvailable: false,
    callCount: 0,
    costUsd: 0,
  }
}

export function createSession(id: string, mode: Mode, tier: Tier = "standard"): SessionState {
  const now = new Date().toISOString()
  return {
    id,
    mode,
    tier,
    messages: [],
    toolCalls: [],
    fileChanges: [],
    readFiles: [],
    startedAt: now,
    updatedAt: now,
    usage: zeroUsage(),
    selectedModel: "auto",
  }
}
