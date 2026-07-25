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
  }
}
