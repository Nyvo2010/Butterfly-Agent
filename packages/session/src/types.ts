// Session state types. No deduplication (COE handles that). No sticky-tier/escalation
// counters (those are Model Router runtime concerns, not session persistence).

export type Role = "user" | "assistant" | "tool" | "system"
export type Mode = "plan" | "build" | "orchestrator"
export type Tier = "trivial" | "standard" | "complex" | "escalate"

export interface SessionMessage {
  id: string
  role: Role
  content: string
  toolCallId?: string // REQUIRED when role === "tool"; runtime-enforced.
  timestamp: string
}

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
    startedAt: now,
    updatedAt: now,
  }
}
