/**
 * @butterfly/client — typed HTTP + SSE client SDK for Butterfly servers.
 *
 * Build a custom client (CLI, TUI, IDE plugin, web app) against a running
 * Butterfly server without depending on the server package.
 *
 *   import { createButterflyClient } from "@butterfly/client"
 *
 *   const client = createButterflyClient({ baseUrl: "http://localhost:3000" })
 *   const { models } = await client.providers()
 *   const s = await client.sessions.create()
 *   const run = await client.promptAndWait(s.id, "Summarize this repo")
 */

export type { ButterflyClientOptions } from "./client"
export { ApiError, ButterflyClient, createButterflyClient } from "./client"
export type { SSEHandle, SSEOptions } from "./sse"
export { openEventStream } from "./sse"
export type {
  ButterflyEvent,
  ButterflyEventKind,
  ConfigInfo,
  DirectoryEntry,
  FileContent,
  FileStatus,
  HealthInfo,
  MCPConfig,
  MCPServerStatus,
  Mode,
  ModelCost,
  ModelLimit,
  ModelSummary,
  PendingPermission,
  ProviderCatalog,
  ProviderSummary,
  RunResult,
  RunStatus,
  SessionState,
  SessionSummary,
  SessionUsage,
  Tier,
  ToolCallRecord,
} from "./types"
