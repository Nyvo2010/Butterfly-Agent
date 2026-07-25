# 🦋 Butterfly Agent

**An intelligent, modular AI coding agent for the command line.**

Butterfly Agent is a pnpm monorepo that provides a production-ready AI agent system. It integrates with any OpenAI-compatible LLM API (OpenAI, Anthropic via gateway, Mistral, self-hosted, etc.) and supports filesystem tools, LSP-powered code intelligence, MCP (Model Context Protocol) servers, and a plugin system.

## Features

- **LLM-agnostic**: Works with any OpenAI-compatible API. Tiered model routing (trivial → standard → complex → escalate) with automatic escalation on tool failures.
- **Filesystem tools**: Read, write, patch, delete, glob, grep, diff/patch, and directory listing with workspace-root path traversal protection.
- **LSP integration**: Go-to-definition, find references, and diagnostics via Language Server Protocol over stdio.
- **MCP support**: Connect to Model Context Protocol servers (stdio or SSE/HTTP transport) for extended tool capabilities.
- **Plugin system**: Opencode-compatible plugin architecture for custom tools and behaviors.
- **Smart Context Engine (SCE)**: Multi-strategy context gathering — regex grep, token-budgeted file snippets, and file tree awareness.
- **Context Optimization Engine (COE)**: Aggressive token-budget management with tool-message truncation, message dropping, and optional semantic compression.
- **Subagent delegation**: Orchestrator mode spawns isolated child agents for parallel task execution.
- **Session persistence**: Save and resume agent sessions with filesystem-backed storage (atomic writes, path-traversal protection).
- **Permission hooks**: Interactive or scriptable permission control for destructive operations.
- **Streaming output**: Real-time LLM response streaming to the terminal.

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
pnpm --filter @butterfly/server dev
# → 🦋 Butterfly Server running at http://localhost:3000
```

3. **Connect with an ACP-compatible client** or use the REST API directly.

### Server Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check with uptime and active runs |
| `GET /providers` | List supported LLM providers |
| `POST /api/sessions` | Create a new agent session |
| `GET /api/sessions` | List all saved sessions |
| `GET /api/sessions/:id` | Get session details |
| `DELETE /api/sessions/:id` | Delete a session |
| `POST /api/sessions/:id/prompt` | Run agent with a prompt |
| `GET /api/sessions/:id/stream` | SSE stream for real-time events |

## Environment Variables

See [`.env.example`](./.env.example) for a complete annotated list.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_API_KEY` | **Yes** | — | Your OpenAI-compatible API key |
| `LLM_BASE_URL` | No | (OpenAI) | Base URL for the LLM API endpoint |
| `AGENT_LOG_LEVEL` | No | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `AGENT_MAX_STEPS` | No | `10` | Maximum agent loop iterations |
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
│   └── acp/                 # @butterfly/acp — Agent Client Protocol integration
├── apps/
│   └── server/              # @butterfly/server — Node.js HTTP server (REST + SSE)
├── docs/                    # SCE.md, COE.md — engine documentation
└── tests/                   # Test suite
```

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

See [DEVELOPMENT.md](./DEVELOPMENT.md) for detailed setup, architecture overview, testing guides, and contribution guidelines.

## License

MIT
