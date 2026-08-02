/**
 * ButterflyClient — typed HTTP + SSE client for the Butterfly server.
 *
 * Lets any custom client (CLI, TUI, IDE plugin, web app) talk to a running
 * Butterfly server without depending on the server package itself. All
 * endpoints are typed against the wire contract in ./types.ts.
 *
 *   const client = createButterflyClient({ baseUrl: "http://localhost:3000" })
 *   const session = await client.sessions.create()
 *   const run = await client.prompt(session.id, "explain this repo", { wait: true })
 */

import { openEventStream, type SSEHandle, type SSEOptions } from "./sse"
import type {
  ButterflyEvent,
  ConfigInfo,
  DirectoryEntry,
  FileContent,
  FileStatus,
  HealthInfo,
  IndexedSymbol,
  MCPConfig,
  MCPServerStatus,
  ModelSummary,
  PendingPermission,
  ProviderCatalog,
  RunResult,
  SearchResponse,
  SessionDiffEntry,
  SessionRunStatus,
  SessionSearchResult,
  SessionSummary,
} from "./types"

export interface ButterflyClientOptions {
  /** Base URL of the Butterfly server, e.g. "http://localhost:3000". */
  baseUrl: string
  /** Optional API key — sent as "Authorization: Bearer <key>". */
  apiKey?: string
  /** Extra headers sent on every request. */
  headers?: Record<string, string>
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof fetch
}

interface RequestOptions {
  method?: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

export class ButterflyClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof fetch

  constructor(opts: ButterflyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.headers = { ...opts.headers }
    if (opts.apiKey) this.headers.Authorization = `Bearer ${opts.apiKey}`
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  // ── Low-level request ────────────────────────────────────────────────────

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }

    const response = await this.fetchImpl(url, {
      method: opts.method ?? "GET",
      headers: {
        ...this.headers,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const data = (await response.json()) as { error?: string }
        if (data.error) message = data.error
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(response.status, message)
    }

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  // ── Health ───────────────────────────────────────────────────────────────

  health(): Promise<HealthInfo> {
    return this.request<HealthInfo>("/health")
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  sessions = {
    list: (
      opts: { limit?: number; cursor?: string; archived?: boolean } = {},
    ): Promise<{
      sessions: SessionSummary[]
      nextCursor: string | null
    }> =>
      this.request("/api/sessions", {
        query: {
          limit: opts.limit,
          cursor: opts.cursor,
          archived: opts.archived ? "true" : undefined,
        },
      }),

    create: (
      body: {
        mode?: "plan" | "build"
        tier?: "trivial" | "standard" | "complex" | "escalate"
        title?: string
        selectedModel?: string
      } = {},
    ): Promise<{ session: import("./types").SessionState }> =>
      this.request("/api/sessions", { method: "POST", body }),

    get: (id: string): Promise<{ session: import("./types").SessionState }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}`),

    update: (
      id: string,
      fields: {
        mode?: "plan" | "build"
        tier?: "trivial" | "standard" | "complex" | "escalate"
        title?: string
        archived?: boolean
        selectedModel?: string
      },
    ): Promise<{ session: import("./types").SessionState }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: fields }),

    delete: (id: string): Promise<{ deleted: boolean }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),

    fork: (id: string): Promise<{ session: import("./types").SessionState }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}/fork`, { method: "POST" }),

    abort: (id: string): Promise<{ aborted: boolean }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" }),

    summarize: (id: string): Promise<{ session: import("./types").SessionState }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}/summarize`, { method: "POST" }),

    messages: (
      id: string,
      opts: { limit?: number; cursor?: string } = {},
    ): Promise<{
      messages: import("./types").SessionState["messages"]
      nextCursor: string | null
    }> => this.request(`/api/sessions/${encodeURIComponent(id)}/messages`, { query: opts }),

    toolCalls: (
      id: string,
    ): Promise<{ toolCalls: import("@butterfly/session").ToolCallRecord[] }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}/tool-calls`),

    fileChanges: (
      id: string,
    ): Promise<{ fileChanges: import("@butterfly/session").FileChange[] }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}/file-changes`),

    status: (
      id: string,
    ): Promise<{ sessionId: string; status: SessionRunStatus; activeRun?: unknown }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}/status`),

    export: (
      id: string,
    ): Promise<{
      schemaVersion: number
      exportedAt: string
      sessionId: string
      session: import("./types").SessionState
    }> => this.request(`/api/sessions/${encodeURIComponent(id)}/export`),

    search: (
      q: string,
      opts: { limit?: number } = {},
    ): Promise<{ query: string; results: SessionSearchResult[] }> =>
      this.request("/api/sessions/search", { query: { q, limit: opts.limit } }),

    diff: (id: string): Promise<{ sessionId: string; diffs: SessionDiffEntry[] }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}/diff`),

    revert: (
      id: string,
      paths?: string[],
    ): Promise<{ restored: string[]; missingBefore: string[] }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}/revert`, {
        method: "POST",
        body: { paths },
      }),

    restore: (id: string, snapshot: string): Promise<{ restored: string }> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}/restore`, {
        method: "POST",
        body: { snapshot },
      }),

    editMessage: (
      id: string,
      messageId: string,
      content: string,
    ): Promise<{ session: import("./types").SessionState }> =>
      this.request(
        `/api/sessions/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: "PATCH",
          body: { content },
        },
      ),

    retry: (id: string): Promise<RunResult> =>
      this.request(`/api/sessions/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  }

  /** Import a session from export JSON. */
  importSession(data: unknown): Promise<{ session: import("./types").SessionState }> {
    return this.request("/api/sessions/import", { method: "POST", body: data })
  }

  /**
   * List available slash commands defined in the server config.
   * Returns a map of command name → prompt template.
   */
  commands(): Promise<{ commands: Record<string, string> }> {
    return this.request("/api/sessions/commands")
  }

  // ── Prompt / run ─────────────────────────────────────────────────────────

  /**
   * Run the agent on a session. With `wait: true` the request blocks until the
   * run finishes (server-side `?wait=true`); otherwise it returns immediately
   * with status "running" and progress arrives over SSE.
   */
  prompt(
    sessionId: string,
    prompt: string,
    opts: { wait?: boolean; maxSteps?: number; temperature?: number } = {},
  ): Promise<RunResult> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      query: opts.wait ? { wait: "true" } : undefined,
      body: { prompt, maxSteps: opts.maxSteps, temperature: opts.temperature },
    })
  }

  /**
   * Convenience: run a prompt and wait for it to finish via the session SSE
   * stream. Returns the terminal run result (completed / aborted / error).
   * Throws if no terminal event arrives before `timeoutMs`.
   */
  async promptAndWait(
    sessionId: string,
    prompt: string,
    opts: { maxSteps?: number; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    const timeout = opts.timeoutMs ?? 10 * 60 * 1000

    // Start the run asynchronously.
    const initial = await this.prompt(sessionId, prompt, { maxSteps: opts.maxSteps })
    if (initial.status !== "running") return initial

    // Wait for a terminal run event on the per-session stream.
    const events: ButterflyEvent[] = []
    const handle = this.subscribeToSession(sessionId, {
      onEvent: (e) => events.push(e),
    })
    await handle.ready

    try {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const terminal = events.find(
          (e) => e.kind === "run.completed" || e.kind === "run.aborted" || e.kind === "run.error",
        )
        if (terminal) {
          const data = terminal.data as {
            iterations?: number
            stopReason?: string
            model?: string
            tier?: string
            message?: string
          }
          if (terminal.kind === "run.error") {
            return { sessionId, status: "error", error: data.message }
          }
          if (terminal.kind === "run.aborted") {
            return { sessionId, status: "aborted" }
          }
          return {
            sessionId,
            status: "completed",
            iterations: data.iterations,
            stopReason: data.stopReason,
            model: data.model,
            tier: data.tier,
          }
        }
        await sleep(25)
      }
      throw new Error(`Timed out waiting for run on session ${sessionId}`)
    } finally {
      handle.close()
    }
  }

  // ── Code search (identifier index) ──────────────────────────────────────

  /**
   * Search the workspace for symbol declarations (functions, classes, etc.).
   * Index is built lazily on first request; pass refresh: true to rebuild.
   */
  searchCode(q: string, opts: { limit?: number; refresh?: boolean } = {}): Promise<SearchResponse> {
    return this.request<SearchResponse>("/api/search", {
      query: { q, limit: opts.limit, refresh: opts.refresh ? "true" : undefined },
    })
  }

  /** Convenience alias returning just the matched symbols. */
  searchSymbols(q: string, limit = 50): Promise<IndexedSymbol[]> {
    return this.searchCode(q, { limit }).then((r) => r.results)
  }

  // ── Providers & models ───────────────────────────────────────────────────

  providers(): Promise<ProviderCatalog> {
    return this.request<ProviderCatalog>("/api/providers")
  }

  models(): Promise<{ models: ModelSummary[]; autoAvailable: boolean }> {
    return this.request("/api/models")
  }

  modelsFor(provider: string): Promise<{ models: ModelSummary[]; provider: string }> {
    return this.request(`/api/models/${encodeURIComponent(provider)}`)
  }

  // ── Config ───────────────────────────────────────────────────────────────

  config(): Promise<ConfigInfo> {
    return this.request<ConfigInfo>("/api/config")
  }

  configProviders(): Promise<{ providers: ConfigInfo["providers"]; current: string }> {
    return this.request("/api/config/providers")
  }

  // ── Files ────────────────────────────────────────────────────────────────

  files = {
    list: (path = "."): Promise<{ path: string; entries: DirectoryEntry[] }> =>
      this.request("/api/file", { query: { path } }),

    read: (path: string): Promise<FileContent> =>
      this.request("/api/file/content", { query: { path } }),

    status: (path: string): Promise<FileStatus> =>
      this.request("/api/file/status", { query: { path } }),

    find: (pattern: string): Promise<{ pattern: string; files: string[] }> =>
      this.request("/api/find/file", { query: { pattern } }),
  }

  // ── MCP ──────────────────────────────────────────────────────────────────

  mcp = {
    list: (): Promise<{ servers: Array<MCPServerStatus & MCPConfig> }> => this.request("/api/mcp"),

    connect: (name: string, config?: MCPConfig): Promise<{ server: MCPServerStatus }> =>
      this.request("/api/mcp/connect", { method: "POST", body: { name, ...config } }),

    disconnect: (name: string): Promise<{ disconnected: boolean; name: string }> =>
      this.request(`/api/mcp/${encodeURIComponent(name)}/disconnect`, { method: "POST" }),
  }

  // ── Permissions (HITL) ───────────────────────────────────────────────────

  permissions = {
    list: (sessionId?: string): Promise<{ pending: PendingPermission[] }> =>
      this.request("/api/permission", { query: sessionId ? { sessionId } : undefined }),

    reply: (requestId: string, answer: string): Promise<{ resolved: boolean; answer: string }> =>
      this.request(`/api/permission/${encodeURIComponent(requestId)}/reply`, {
        method: "POST",
        body: { answer },
      }),
  }

  // ── SSE subscriptions ────────────────────────────────────────────────────

  /**
   * Subscribe to the global event stream. Returns a handle with close().
   * Reconnects automatically with Last-Event-ID resume.
   */
  subscribeEvents(opts: Omit<SSEOptions, "lastEventId"> & { lastEventId?: string }): SSEHandle {
    return openEventStream(`${this.baseUrl}/api/event`, opts)
  }

  /** Subscribe to events for a single session. */
  subscribeToSession(sessionId: string, opts: Omit<SSEOptions, "lastEventId">): SSEHandle {
    return openEventStream(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/stream`,
      opts,
    )
  }

  /** Subscribe and collect events into an array (handy for tests). */
  async collectEvents(
    sessionId: string | undefined,
    predicate?: (e: ButterflyEvent) => boolean,
    timeoutMs = 5000,
  ): Promise<ButterflyEvent[]> {
    const events: ButterflyEvent[] = []
    const handle = sessionId
      ? this.subscribeToSession(sessionId, {
          onEvent: (e) => {
            events.push(e)
          },
        })
      : this.subscribeEvents({
          onEvent: (e) => {
            events.push(e)
          },
        })
    await handle.ready
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate ? events.some(predicate) : events.length > 0) break
      await sleep(25)
    }
    handle.close()
    return events
  }
}

/** Error thrown for non-2xx responses. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Create a typed Butterfly client. */
export function createButterflyClient(opts: ButterflyClientOptions): ButterflyClient {
  return new ButterflyClient(opts)
}
