/**
 * @butterfly/server — Butterfly Agent server core.
 *
 * This package owns everything the backend needs to serve a thin UI client:
 *   - ServerApp: shared application core (config, tokenizer, store, llm, bus)
 *   - EventBus: decoupled publish/subscribe for session/run/tool/file events
 *   - SessionManager: session CRUD + summary + usage + forking
 *   - RunStateManager: live run lifecycle (running/idle, cancel)
 *   - HTTP server: modular route groups + SSE event stream
 *   - Router: lightweight node:http router with path params
 *
 * The client (future package) owns only UI — it talks to this server via HTTP
 * + SSE. This mirrors OpenCode's client/server split where the server handles
 * all agent logic, session state, and event broadcasting.
 */

export type { CreateAgentOptions, ServerAppOptions } from "./app"
// ─── Core ──────────────────────────────────────────────────────────────────────
export { ServerApp } from "./app"
export type {
  ButterflyEvent,
  ButterflyEventKind,
  FileEventKind,
  MCPEventKind,
  PermissionEventKind,
  RunEventKind,
  SessionEventKind,
  StreamEventKind,
  ToolEventKind,
} from "./bus"
// ─── Event Bus ─────────────────────────────────────────────────────────────────
export { _resetEventIdCounter, EVENT_CATEGORIES, EventBus } from "./bus"
export type { HttpServerHandle, HttpServerOptions } from "./http"
// ─── HTTP Server ───────────────────────────────────────────────────────────────
export { createHttpServer, startHttpServer } from "./http"
export type { HttpMethod, RouteContext, RouteHandler } from "./router"
// ─── Router ────────────────────────────────────────────────────────────────────
export {
  badRequest,
  CORS_HEADERS,
  created,
  json,
  notFound,
  ok,
  Router,
  serverError,
} from "./router"
// ─── Permission helpers ────────────────────────────────────────────────────────
export { hasPendingPermissions, requestPermission } from "./routes/permission"
export type { RunStatus } from "./run-state"
// ─── Run State ─────────────────────────────────────────────────────────────────
export { RunStateManager } from "./run-state"
export type { CreateSessionOptions, UpdateSessionFields } from "./session-manager"
// ─── Session Manager ───────────────────────────────────────────────────────────
export {
  accumulateUsage,
  deriveTitle,
  generateSummary,
  SessionManager,
} from "./session-manager"
