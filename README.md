# 🦋 Butterfly Agent

**An intelligent, modular AI coding agent with a server/client architecture.**

Butterfly Agent is a pnpm monorepo that provides a production-ready AI agent system with a clean separation between a **server** (agent logic, session state, event broadcasting) and a **client** (pure UI). The server integrates with any OpenAI-compatible LLM API (OpenAI, Anthropic via gateway, Mistral, self-hosted, etc.) and supports filesystem tools, LSP-powered code intelligence, MCP (Model Context Protocol) servers, and a plugin system.

## Architecture

```
┌──────────────┐        HTTP + SSE        ┌──────────────────────────────┐
│   Client     │ ◄──────────────────────► │         Server               │
│  (UI only)   │   /api/event (events)    │  @butterfly/server           │
│              │   /api/sessions (CRUD)   │  ├─ ServerApp (shared core)  │
│  - Renders   │   /api/sessions/:id/     │  ├─ EventBus (pub/sub)       │
│    events    │     prompt (agent run)   │  ├─ SessionManager           │
│  - Sends     │   /api/file/* (browsing) │  ├─ RunStateManager          │
│    prompts   │   /api/permission (HITL) │  ├─ HTTP routes (modular)    │
│  - Shows     │                          │  └─ @butterfly/agent (loop)  │
│    sessions  │                          │      ├─ SCE + COE            │
│              │                          │      ├─ ModelRouter (tiers)  │
│              │                          │      ├─ ToolRegistry         │
│              │                          │      └─ Subagent             │
└──────────────┘                          └──────────────────────────────┘
```

The server owns **all** agent logic, session state, and event broadcasting. The client owns **only** UI — it subscribes to the global `/api/event` SSE stream and sends HTTP requests. This mirrors OpenCode's architecture where the server is the single source of truth.

## Features

- **Server/client split**: Clean separation — the server (`@butterfly/server`) handles all agent logic; the client (future) is pure UI.
- **Event bus**: Decoupled publish/subscribe system with 23 typed event kinds across 7 categories (session, run, stream, tool, file, permission, mcp). Multiple clients can watch one session.
- **LLM-agnostic**: Works with any OpenAI-compatible API. Tiered model routing (trivial → standard → complex → escalate) with automatic escalation on tool failures.
- **Filesystem tools**: Read, write, patch, delete, glob, grep, diff/patch, and directory listing with workspace-root path traversal protection.
- **Web fetch tool**: Fetch content from URLs with SSRF protection (private IP blocking).
- **LSP integration**: Go-to-definition, find references, and diagnostics via Language Server Protocol over stdio.
- **MCP support**: Connect to Model Context Protocol servers (stdio or SSE/HTTP transport) for extended tool capabilities.
- **Plugin system**: Opencode-compatible plugin architecture for custom tools and behaviors.
- **Smart Context Engine (SCE)**: Multi-strategy context gathering — regex grep, token-budgeted file snippets, and file tree awareness.
- **Context Optimization Engine (COE)**: Aggressive token-budget management with tool-message truncation, message dropping, and optional semantic compression.
- **Subagent delegation**: Orchestrator mode spawns isolated child agents for parallel task execution.
- **Session management**: Session CRUD, forking, archiving, title derivation, token/cost accounting, and summarization.
- **Run-state tracking**: Per-session run lifecycle (running/idle) with concurrency-safe abort handling.
- **Permission hooks**: Interactive or scriptable permission control for destructive operations, with HTTP-based human-in-the-loop.
- **Streaming output**: Real-time LLM response streaming via SSE event stream.
- **ACP support**: Agent Client Protocol integration for IDE/CLI clients.

## Prerequisites

- **Node.js** ≥ 18
- **pnpm** ≥ 10 (`npm install -g pnpm`)
- **LLM API key**: Any OpenAI-compatible API key (OpenAI, Anthropic via gateway, Mistral, etc.)

## Installation

```bash
# Clone the repository
git clone https://github.com/butterfly-agent/butterfly-agent.git
cd butterfly-agent

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

## Quick Start

1. **Set your API key** (create a `.env` file from the example):

```bash
cp .env.example .env
# Edit .env and set your LLM_API_KEY
```

2. **Start the server**:

```bash
pnpm --filter @butterfly/server-app dev
# → 🦋 Butterfly Server running at http://localhost:3000
```

3. **Connect a client** (future) or use the REST API directly.

### Server API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with uptime and active runs |
| `/api/event` | GET | **Global SSE event stream** — all session/run/tool/file events |
| `/api/sessions` | GET | List sessions (with title, usage, archived status) |
| `/api/sessions` | POST | Create a new session (mode, tier, title) |
| `/api/sessions/:id` | GET | Get session details |
| `/api/sessions/:id` | DELETE | Delete a session (aborts any active run) |
| `/api/sessions/:id` | PATCH | Update session (mode, tier, title, archived) |
| `/api/sessions/:id/prompt` | POST | Run agent with a prompt |
| `/api/sessions/:id/abort` | POST | Abort an active run |
| `/api/sessions/:id/fork` | POST | Fork a session (deep copy with parentSessionId) |
| `/api/sessions/:id/summarize` | POST | Generate and persist a session summary |
| `/api/sessions/:id/messages` | GET | Get session messages |
| `/api/sessions/:id/tool-calls` | GET | Get session tool call history |
| `/api/sessions/:id/file-changes` | GET | Get session file change history |
| `/api/sessions/:id/status` | GET | Get run status (idle/running) |
| `/api/sessions/:id/stream` | GET | **Per-session SSE event stream** |
| `/api/file` | GET | List directory contents (workspace-bound) |
| `/api/file/content` | GET | Read file content (workspace-bound) |
| `/api/file/status` | GET | Get file metadata |
| `/api/find/file` | GET | Find files by glob pattern |
| `/api/config` | GET | Get Butterfly configuration (redacted) |
| `/api/config/providers` | GET | List configured providers |
| `/api/providers` | GET | List available LLM providers |
| `/api/mcp` | GET | List MCP server configurations |
| `/api/permission` | GET | List pending permission requests |
| `/api/permission/:id/reply` | POST | Respond to a permission request (HITL) |

## Environment Variables

See [`.env.example`](./.env.example) for a complete annotated list.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_API_KEY` | **Yes** | — | Your OpenAI-compatible API key |
| `LLM_BASE_URL` | No | (OpenAI) | Base URL for the LLM API endpoint |
| `AGENT_LOG_LEVEL` | No | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `AGENT_MAX_STEPS` | No | `20` | Maximum agent loop iterations |
| `BUTTERFLY_MODEL` | No | `anthropic/claude-sonnet-4-5` | Default model override |
| `BUTTERFLY_MODEL_TRIVIAL` | No | tier default | Model for trivial tasks |
| `BUTTERFLY_MODEL_STANDARD` | No | tier default | Model for standard tasks |
| `BUTTERFLY_MODEL_COMPLEX` | No | tier default | Model for complex tasks |
| `BUTTERFLY_MODEL_ESCALATE` | No | tier default | Model for escalate tier |
| `DEBUG` | No | `false` | Enable debug output |
| `DEBUG_NAMESPACE` | No | `butterfly:*` | Debug namespace filter |
| `TRACE_ENABLED` | No | `false` | Enable OpenTelemetry tracing |
| `TRACE_EXPORTER` | No | `console` | Trace exporter: `console`, `otlp`, `zipkin` |

## Configuration File

Butterfly supports an Opencode-compatible configuration file (`.butterfly/config.json` or `.butterfly/config.jsonc`) with JSONC (comments) support. A global config at `~/.butterfly/config.json` provides shared defaults.

```jsonc
{
  "model": "anthropic/claude-sonnet-4-5",
  "instructions": ["You are a TypeScript expert."],
  "mcp": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  },
  "butterfly": {
    "tiers": {
      "trivial": "anthropic/claude-haiku-4-5",
      "standard": "anthropic/claude-sonnet-4-5",
      "complex": "anthropic/claude-sonnet-4-5",
      "escalate": "anthropic/claude-opus-4-1"
    },
    "sce": { "maxFiles": 5, "maxTokensPerFile": 2000 },
    "coe": { "maxContextTokens": 8000 },
    "maxSteps": 20
  }
}
```

## Project Structure

```
butterfly-agent/
├── core/                    # @butterfly/core — config, logging, dotenv, tracing
├── packages/
│   ├── session/             # @butterfly/session — types, FS store, SQLite store
│   ├── tools/               # @butterfly/tools — 13 tools, registry, MCP, plugins
│   ├── llm/                 # @butterfly/llm — Vercel AI, Anthropic, Gemini adapters
│   ├── context/             # @butterfly/context — SCE + COE + tokenizer + LSP
│   ├── agent/               # @butterfly/agent — loop, prompt, router, modes, subagent
│   ├── server/              # @butterfly/server — ServerApp, EventBus, SessionManager,
│   │                        #   RunStateManager, HTTP routes (modular), SSE streams
│   └── acp/                 # @butterfly/acp — Agent Client Protocol integration
├── apps/
│   └── server/              # @butterfly/server-app — thin HTTP server entry point
├── docs/                    # SCE.md, COE.md — engine documentation
└── tests/                   # Test suite (113+ tests)
```

### Server Architecture (`@butterfly/server`)

The server core package owns all backend logic needed to serve a thin UI client:

| Module | Responsibility |
|--------|---------------|
| `app.ts` | **ServerApp** — shared core owning config, tokenizer, store, LLM, bus, session-manager, run-state. Eliminates bootstrap duplication between HTTP and ACP. |
| `bus.ts` | **EventBus** — typed publish/subscribe with 23 event kinds; auto-derives `type` from `kind`; multiple subscribers per event. |
| `session-manager.ts` | **SessionManager** — session CRUD + title derivation + token/cost accumulation + forking + archiving + summarization. |
| `run-state.ts` | **RunStateManager** — per-session run lifecycle (running/idle) with `expectedAbort` concurrency guard. |
| `router.ts` | Lightweight node:http router with path params. |
| `http.ts` | HTTP server composing all route groups with CORS, body parsing, error handling. |
| `routes/` | Modular route groups: session, event (SSE), file, config, mcp, provider, permission. |

## Development

```bash
# Install dependencies
pnpm install

# Typecheck all packages
pnpm typecheck

# Run all tests
pnpm test

# Lint
pnpm lint

# Format
pnpm format
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed setup, architecture overview, testing guides, and contribution guidelines.

## License

MIT
