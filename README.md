# 🦋 Butterfly Agent

**An intelligent, modular AI coding agent with a server/client architecture.**

Butterfly Agent is a pnpm monorepo providing a production-ready agent **backend**: a
typed HTTP + SSE server that owns all agent logic, session state, and event
broadcasting. Clients are pure UI — you can build your own in any language.

```
┌──────────────┐        HTTP + SSE        ┌──────────────────────────────┐
│  Your client │ ◄──────────────────────► │         Butterfly Server     │
│  (CLI, TUI,  │   /api/event (SSE)      │  @butterfly/server           │
│   IDE, web)  │   /api/sessions (CRUD)  │  ├─ ServerApp (shared core)  │
│              │   /api/sessions/:id/    │  ├─ EventBus (typed pub/sub)  │
│              │     prompt (agent run)  │  ├─ SessionManager            │
│              │   /api/providers (LLMs) │  ├─ RunStateManager           │
│              │   /api/permission (HITL)│  ├─ AgentLoop (SCE+COE)       │
│              │                        │  ├─ Model Router (tiers)      │
│              │   ─ or over stdio ─    │  ├─ Tool Registry (14 tools)  │
│              │   ACP (JSON-RPC)        │  └─ MCP / LSP integrations   │
└──────────────┘                        └──────────────────────────────┘
```

## Why this architecture

- **Backend owns everything**: agent loop, session state, LLM routing, tools,
  permissions, MCP/LSP. The server is the single source of truth — mirroring
  OpenCode's architecture.
- **Clients are thin**: subscribe to `/api/event` (SSE) and call typed endpoints.
- **No client in this repo (yet)**: build your own with `@butterfly/client` (TS),
  the OpenAPI spec at `/openapi.json`, the ACP stdio server, or plain HTTP.

---

## Quick Start

```bash
# 1. Install
pnpm install

# 2. Configure (copy .env.example → .env and set LLM_API_KEY + model)
cp .env.example .env

# 3. Start the HTTP server
pnpm --filter @butterfly/server-app dev
# 🦋 Butterfly Server running at http://127.0.0.1:3000

# 4. Health check
curl http://127.0.0.1:3000/health
```

Try it:

```bash
# List available providers + models (from the models.dev catalog)
curl http://127.0.0.1:3000/api/providers

# Create a session and run the agent
curl -X POST http://127.0.0.1:3000/api/sessions -H 'Content-Type: application/json' \
  -d '{"mode":"build"}'

curl -X POST http://127.0.0.1:3000/api/sessions/<id>/prompt?wait=true \
  -H 'Content-Type: application/json' -d '{"prompt":"explain this repo"}'
```

### Verification commands

```bash
pnpm typecheck   # tsc across all packages
pnpm lint        # biome check
pnpm test        # vitest (224+ tests)
pnpm build       # compile all packages
pnpm format      # biome format
```

### Live LLM integration tests (opt-in)

The default suite uses mock LLMs (deterministic, free). To exercise the real
provider path (streaming, retries, tool-call parsing) against a live API:

```bash
BUTTERFLY_TEST_LIVE=1 LLM_API_KEY=sk-... npx vitest run tests/live-llm.test.ts
```

Skipped automatically when `BUTTERFLY_TEST_LIVE` is unset or no key is present.

---

## Building a custom client

### Option 1 — TypeScript SDK (`@butterfly/client`)

```ts
import { createButterflyClient } from "@butterfly/client"

const client = createButterflyClient({ baseUrl: "http://localhost:3000" })

// Browse providers/models
const { models, providers } = await client.providers()
const pick = models.find((m) => m.id === "anthropic/claude-sonnet-4-5")

// Sessions
const session = await client.sessions.create({ mode: "build", selectedModel: pick?.id })

// Run the agent and wait for it to finish
const run = await client.promptAndWait(session.id, "Refactor this into modules")

// Or run async + stream events
const { subscribeEvents, subscribeToSession } = client
const handle = subscribeToSession(session.id, {
  onEvent: (e) => console.log(e.kind, e.data),
})
await client.prompt(session.id, "Show me the architecture")
handle.close() // unsubscribes

// Human-in-the-loop permission flow
const { pending } = await client.permissions.list(session.id)
for (const req of pending) {
  await client.permissions.reply(req.requestId, "yes")
}
```

### Option 2 — Plain HTTP + SSE (any language)

- **Endpoints**: see [API Reference](#api-reference) or `GET /openapi.json`
  (auto-generated OpenAPI 3.0 spec).
- **Events**: `GET /api/event` (global) and `GET /api/sessions/:id/stream`
  (per-session) are SSE streams. Each event carries an `id` — resume with
  `Last-Event-ID` after a reconnect (the server replays the last 500 events).

Event kinds: `session.*` (incl. `session.imported`), `run.*` (incl.
`run.recovered` after a restart sweep), `stream.text_delta` (live tokens),
`stream.reasoning`, `stream.usage`, `tool.*`, `file.changed`, `message.added`,
`permission.*`, `mcp.*`.

### Option 3 — ACP (Agent Client Protocol over stdio)

Any ACP-compatible client (IDE, CLI, TUI) can drive Butterfly directly:

```bash
pnpm --filter @butterfly/acp-app dev          # run the ACP stdio server
# or install as a bin:
# butterfly-acp
```

Works with tools like the official `acp` CLI:

```bash
acp run "pnpm --filter @butterfly/acp-app dev" -- "explain this repo"
```

Auth: set `BUTTERFLY_API_KEY` and ACP clients provide `apiKey`/`token`/`bearerToken`
in `authenticate`.

---

## Providers, models & routing

- **Providers**: OpenAI, Anthropic, Gemini, DeepSeek, Groq, xAI, OpenRouter,
  Mistral, Cohere, Perplexity, Cerebras, Fireworks, Together AI, Azure, Bedrock,
  GitHub Copilot, Cloudflare, Baseten, DeepInfra, Vercel — plus any
  OpenAI-compatible endpoint via `providers` in `.butterfly/config.json`.
- **Model catalog**: fetched from models.dev (cached 5 min with disk fallback),
  with per-model cost, context limits, capabilities, and status.
- **Tiered routing**: trivial → standard → complex → escalate, with automatic
  escalation on tool failures. Pick a fixed model per session via
  `selectedModel`, or "auto" for tiered routing.
- **Streaming**: all adapters stream text, reasoning, and tool-call deltas
  end-to-end to the SSE bus.

```jsonc
// .butterfly/config.json (JSONC comments allowed)
{
  "model": "anthropic/claude-sonnet-4-5",
  "providers": {
    "deepseek": {
      "provider": "deepseek",
      "apiKey": "sk-...",
      "models": { "deepseek-chat": {} }
    },
    // Provider-level options are forwarded into every request body:
    "openai": {
      "provider": "openai",
      "apiKey": "sk-...",
      "options": { "reasoning_effort": "low" },
      "models": {
        "gpt-4o": { "request": { "headers": { "X-Custom": "1" } } }
      }
    }
  },
  "butterfly": {
    "tiers": {
      "trivial": "deepseek/deepseek-chat",
      "standard": "deepseek/deepseek-chat",
      "complex": "anthropic/claude-sonnet-4-5",
      "escalate": "anthropic/claude-opus-4-1"
    },
    "coe": {
      // When unset, the budget is derived from the model's catalog context
      // window (70% of it) — small-model friendly, big-model aware.
      "maxContextTokens": 8000
    },
    "maxSteps": 20
  }
}
```

## Context budget (model-aware)

COE's context budget defaults to a model-aware value: when `butterfly.coe.maxContextTokens`
is unset, the server looks up the selected model's context window in the models.dev
catalog and uses 70% of it (min 1000, fallback 8000). So a 128k model isn't crushed
into an 8k budget, and a small 7B model with an 8k window still fits. Explicit config
always wins.

## Slash commands & file references

Two client-facing conveniences are built into the backend, ready for any UI:

### Slash commands

Define custom commands in `.butterfly/config.json` under the `commands` key.
Each maps a `/name` to a prompt template; `{args}` is replaced by the rest of
the user's input after the command name:

```jsonc
{
  "commands": {
    "fix": "Fix the following issue in the codebase: {args}",
    "test": "Write tests for: {args}",
    "explain": "Explain this code in detail: {args}",
    "deploy": "Deploy the project now."
  }
}
```

- A prompt of `/fix the login bug` is rewritten to
  `Fix the following issue in the codebase: the login bug` before the loop runs.
- Unknown commands pass through unchanged.
- Clients can discover available commands via `GET /api/sessions/commands`.

### External file references

Reference files in any prompt with `@path/to/file.ts`. The server extracts the
references, reads the files (workspace-bound, 1MB cap), and injects their
content into the first user message as a `REFERENCED FILES:` block — the model
sees the code without an explicit read call:

```
"Refactor @src/utils.ts and @src/index.ts to share a helper"
```

- Files are resolved against the server `cwd`; absolute paths work too.
- Missing or oversized files are skipped with an inline `[SKIPPED: …]` notice.
- Multi-turn: the `@path` text stays in the query so the model can still `read`
  the file itself if it wants.

## Cost tracking

Each session accumulates an estimated `costUsd` alongside token counts,
computed from the model's catalog pricing (per-1M-token input/output).
Configured provider model overrides take precedence over catalog prices (useful
for proxies/self-hosted gateways). Visible in `session.usage.costUsd` and on
`/api/sessions` lists. Unknown pricing leaves the field unset rather than
misleading the user.

## Session safety

- **No silent deletion**: sessions are never auto-deleted by default. Enable
  cleanup explicitly via `butterfly.backgroundJobs.staleSessionAgeMs` (e.g.
  7 days = `604800000`).
- **Run recovery**: an `activeRun` marker is persisted when a run starts. After
  a server restart, `/api/sessions/:id/status` reports `interrupted` for
  sessions whose run was cut off (with the stale run metadata) instead of lying
  that they're still running.
- **Export/import**: sessions export to portable JSON (`/api/sessions/:id/export`)
  and import into a fresh session (`/api/sessions/import`) — shareable across
  machines, never overwrites existing data.

---

## Parallelism & concurrency

Butterfly is built for parallel use:

- **Multiple sessions at once**: run any number of sessions concurrently; the
  `RunStateManager` tracks each independently (`/api/sessions/:id/status`).
- **One run per session**: a new prompt on a busy session aborts the in-flight
  run first (with a concurrency-safe `expectedAbort` guard).
- **Parallel-safe tool execution**: pure reads (`read`, `grep`, `glob`, `list`,
  `search`, `web_fetch`) run concurrently within a single agent step; writes,
  bash, and interactive tools run serially for determinism.
- **Streaming to many clients**: the event bus supports many SSE subscribers
  per process (max 200 listeners) with per-session filtering.

```ts
// Example: two sessions in parallel
const [s1, s2] = await Promise.all([client.sessions.create(), client.sessions.create()])
const [r1, r2] = await Promise.all([
  client.promptAndWait(s1.id, "Task A"),
  client.promptAndWait(s2.id, "Task B"),
])
```

---

## Security

- **API key auth** (optional): `BUTTERFLY_API_KEY` — timing-safe compare,
  configurable header, `/health` + `/openapi.json` stay public.
- **Workspace confinement**: file tools reject paths outside `cwd`
  (symlink-aware); bash `workdir` validated against workspace roots.
- **SSRF protection** in `web_fetch` (private/loopback/metadata IPs blocked).
- **Command safety**: dangerous shell patterns and injection metacharacters
  blocked; output truncated with file offload.
- **Persistence safety**: atomic tmp+rename writes, per-file locking with
  stale-lock detection, session-id sanitization (path-traversal-proof).
- **Rate limiting**: per-IP/API-key buckets with SSE/health exempt paths.

---

## Environment variables

See [`.env.example`](./.env.example) for the annotated list. Key ones:

| Variable | Default | Description |
|---|---|---|
| `LLM_API_KEY` | — | OpenAI-compatible API key (required) |
| `BUTTERFLY_MODEL` | `anthropic/claude-sonnet-4-5` | Default model (provider/model) |
| `BUTTERFLY_MODEL_{TRIVIAL,STANDARD,COMPLEX,ESCALATE}` | tier default | Per-tier overrides |
| `BUTTERFLY_API_KEY` | unset | Enable HTTP+ACP auth (Bearer) |
| `BUTTERFLY_CWD` | `process.cwd()` | Working directory for the agent |
| `BUTTERFLY_SESSION_STORE` | `fs` | `fs` or `sqlite` persistence |
| `BUTTERFLY_LSP` | `1` | LSP integration toggle |
| `PORT` | `3000` | HTTP port |
| `AGENT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `AGENT_MAX_STEPS` | `20` | Max agent loop iterations |

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health, uptime, active runs |
| `/api/event` | GET | **Global SSE stream** (all events) |
| `/api/sessions` | GET/POST | List (cursor-paginated) / create |
| `/api/sessions/:id` | GET/PATCH/DELETE | Get / update / delete |
| `/api/sessions/:id/prompt` | POST | Run agent (`?wait=true` to block) |
| `/api/sessions/:id/abort` | POST | Abort active run |
| `/api/sessions/:id/fork` | POST | Fork a session |
| `/api/sessions/:id/summarize` | POST | Generate summary |
| `/api/sessions/:id/messages` | GET | Messages (cursor-paginated) |
| `/api/sessions/:id/tool-calls` | GET | Tool call history |
| `/api/sessions/:id/file-changes` | GET | File change history |
| `/api/sessions/:id/status` | GET | Run status (running/idle/interrupted) |
| `/api/sessions/:id/stream` | GET | **Per-session SSE stream** |
| `/api/sessions/:id/export` | GET | Export session as portable JSON |
| `/api/sessions/:id/diff` | GET | Unified diff of file changes |
| `/api/sessions/:id/revert` | POST | Revert files to before-state (workspace-bound) |
| `/api/sessions/:id/restore` | POST | Restore working tree to a git snapshot |
| `/api/sessions/:id/messages/:messageId` | PATCH | Edit a message's content |
| `/api/sessions/:id/retry` | POST | Truncate to last user message + re-run |
| `/api/sessions/commands` | GET | List configured slash commands |
| `/api/sessions/search` | GET | Search sessions by title/content |
| `/api/sessions/import` | POST | Import a session from export JSON |
| `/api/search` | GET | Symbol-level code search (identifier index) |
| `/api/providers` | GET | Providers + full model catalog |
| `/api/models` | GET | Model catalog |
| `/api/models/:provider` | GET | Models for one provider |
| `/api/config` | GET | Redacted config |
| `/api/file` | GET | List directory (workspace-bound) |
| `/api/file/content` | GET | Read file |
| `/api/file/status` | GET | File metadata |
| `/api/find/file` | GET | Glob search |
| `/api/mcp` | GET | MCP server status |
| `/api/mcp/connect` | POST | Connect an MCP server |
| `/api/mcp/:name/connect` · `disconnect` | POST | Connect / disconnect |
| `/api/permission` | GET | Pending HITL requests |
| `/api/permission/:requestId/reply` | POST | Reply to a request |
| `/openapi.json` | GET | Auto-generated OpenAPI spec |

---

## Project structure

```
├── core/                    # @butterfly/core — config, logging, dotenv, tracing
├── packages/
│   ├── session/             # @butterfly/session — types, FS store, SQLite store
│   ├── tools/               # @butterfly/tools — 14 tools, registry, MCP, plugins
│   ├── llm/                 # @butterfly/llm — Vercel AI, Anthropic, Gemini adapters
│   ├── context/             # @butterfly/context — SCE + COE + tokenizer + LSP
│   ├── agent/               # @butterfly/agent — loop, prompt, router, subagent
│   ├── server/              # @butterfly/server — ServerApp, EventBus, HTTP routes
│   ├── acp/                 # @butterfly/acp — Agent Client Protocol integration
│   └── client/              # @butterfly/client — typed HTTP+SSE client SDK
├── apps/
│   ├── server/              # HTTP server entry point
│   └── acp/                 # ACP stdio server entry point
├── docs/                    # SCE.md, COE.md
└── tests/                   # Vitest suite (224+ tests incl. opt-in live LLM)
```

## License

MIT
