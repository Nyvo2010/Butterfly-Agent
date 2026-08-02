/**
 * Wire types for @butterfly/client — mirror the server's HTTP + SSE contract
 * so custom clients get first-class typing without importing the server package.
 */

import type {
  FileChange,
  Mode,
  SessionState,
  SessionUsage,
  Tier,
  ToolCallRecord,
} from "@butterfly/session"

// ─── Events (SSE) ────────────────────────────────────────────────────────────

/** Event kinds emitted by the server event bus (subset of the server's union). */
export type ButterflyEventKind =
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "session.archived"
  | "session.forked"
  | "session.imported"
  | "run.started"
  | "run.completed"
  | "run.aborted"
  | "run.error"
  | "run.recovered"
  | "stream.connected"
  | "stream.text_delta"
  | "stream.reasoning"
  | "stream.usage"
  | "tool.start"
  | "tool.result"
  | "tool.error"
  | "file.changed"
  | "message.added"
  | "message.updated"
  | "message.removed"
  | "todo.updated"
  | "permission.requested"
  | "permission.resolved"
  | "mcp.connected"
  | "mcp.disconnected"
  | "mcp.error"

/** A single event delivered over the SSE stream. */
export interface ButterflyEvent {
  id: string
  kind: ButterflyEventKind
  type: string
  timestamp: string
  sessionId?: string
  data: Record<string, unknown>
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/** Summary of a session as returned by GET /api/sessions. */
export interface SessionSummary {
  id: string
  mode: Mode
  tier: Tier
  title: string
  selectedModel: string
  updatedAt: string
  startedAt: string
  usage?: SessionUsage
  archived: boolean
  parentSessionId?: string
}

// ─── Models / Providers ──────────────────────────────────────────────────────

export interface ModelCost {
  input: number
  output: number
}

export interface ModelLimit {
  context: number
  output: number
}

export interface ModelSummary {
  id: string
  name: string
  provider: string
  builtin: boolean
  family?: string
  cost?: ModelCost
  limit?: ModelLimit
  status?: string
  toolCall?: boolean
  reasoning?: boolean
}

export interface ProviderSummary {
  id: string
  name: string
  provider: string
  prefix: string
  baseURL?: string
  modelCount: number
  env?: string[]
}

export interface ProviderCatalog {
  providers: ProviderSummary[]
  models: ModelSummary[]
  current: string
  autoAvailable: boolean
}

// ─── Agent runs ──────────────────────────────────────────────────────────────

export type RunStatus = "running" | "completed" | "aborted" | "error"

/** Live run status reported by GET /api/sessions/:id/status. */
export type SessionRunStatus = "running" | "idle" | "interrupted"

export interface RunResult {
  sessionId: string
  status: RunStatus
  iterations?: number
  stopReason?: string
  model?: string
  tier?: string
  usage?: SessionUsage
  fileChanges?: Array<{ path: string; kind: string }>
  toolCalls?: Array<{ name: string; error?: string }>
  error?: string
}

// ─── Files ───────────────────────────────────────────────────────────────────

export interface DirectoryEntry {
  name: string
  type: "file" | "directory"
}

export interface FileContent {
  path: string
  content: string
  size: number
}

export interface FileStatus {
  path: string
  size: number
  isDirectory: boolean
  modifiedAt: string
}

// ─── Permissions (HITL) ──────────────────────────────────────────────────────

export interface PendingPermission {
  requestId: string
  sessionId: string
  tool: string
  category: string
  question: string
  options?: string[]
  createdAt: string
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

export interface MCPServerStatus {
  name: string
  connected: boolean
  toolCount: number
  error?: string
}

export interface MCPConfig {
  command?: string
  url?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  headers?: Record<string, string>
}

// ─── Server info ─────────────────────────────────────────────────────────────

export interface HealthInfo {
  status: string
  uptime: number
  activeRuns: number
  model: string
  routes: number
  requestId: string
}

export interface ConfigInfo {
  model: string
  providers: Record<string, { provider: string; baseURL?: string; disabled?: boolean }>
  permission?: unknown
  butterfly?: unknown
  agent: { logLevel: string; maxSteps: number }
}

// ─── Session diff / search ───────────────────────────────────────────────────

export interface SessionDiffEntry {
  path: string
  kind: string
  at: string
  diff: string
}

export interface SessionSearchResult {
  id: string
  title: string
  summary?: string
  updatedAt: string
  matches: Array<{ role: string; content: string }>
}

export interface IndexedSymbol {
  name: string
  kind: string
  path: string
  relPath: string
  line: number
}

export interface SearchResponse {
  query: string
  results: IndexedSymbol[]
  stats: { files: number; symbols: number; indexedAt: string; tookMs: number }
  indexBuilt: boolean
}

// Re-export useful session types for consumers building clients.
export type { FileChange, Mode, SessionState, SessionUsage, Tier, ToolCallRecord }
