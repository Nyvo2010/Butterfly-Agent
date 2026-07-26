# Contributing to Butterfly Agent

First off, thank you for considering contributing to Butterfly Agent! Your help is essential for making this project successful.

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Development Setup

### Prerequisites

- **Node.js** ≥ 18 (we recommend using [nvm](https://github.com/nvm-sh/nvm) — see `.nvmrc`)
- **pnpm** ≥ 10 (`npm install -g pnpm`)
- **LLM API key** for integration testing (any OpenAI-compatible API key)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/butterfly-agent/butterfly-agent.git
cd butterfly-agent

# Install all dependencies
pnpm install

# Set up environment variables (optional, for integration tests)
cp .env.example .env
# Edit .env and set your LLM_API_KEY

# Build all packages
pnpm build
```

### Available Commands

| Command | Description |
|---------|-------------|
| `pnpm test` | Run all tests (106+ tests) |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm typecheck` | Check TypeScript types across all packages |
| `pnpm lint` | Lint all source files with Biome |
| `pnpm lint:fix` | Auto-fix lint issues |
| `pnpm format` | Format all source files with Biome |
| `pnpm build` | Build all packages to `dist/` |

### Running Tests

All tests are located in the `tests/` directory at the project root. We use [Vitest](https://vitest.dev) as the test runner.

```bash
# Run the full test suite
pnpm test

# Run a specific test file
npx vitest run tests/agent.test.ts

# Run tests matching a pattern
npx vitest run tests/server

# Run tests in watch mode
pnpm test:watch
```

#### Test Structure

- **Unit tests**: Located in `tests/*.test.ts`, organized by package domain
- **Mock LLM**: `tests/mock-llm.ts` provides a deterministic LLM client for loop testing
- **Fixtures**: `tests/fixtures.ts` provides reusable test factories for sessions, messages, tool calls, etc.
- **No external dependencies**: All package tests run without an LLM API key — they use mocks and stubs

#### Adding Tests

When adding new functionality, please include corresponding tests. Follow the existing patterns:

1. Use `describe`/`it`/`expect` from Vitest
2. Place test files in `tests/` directory
3. Use fixtures from `tests/fixtures.ts` when possible
4. Use `tests/mock-llm.ts` for agent loop tests
5. Keep tests deterministic — no network or filesystem dependencies unless necessary

## Project Architecture

Butterfly is a **pnpm monorepo** with strict modularity boundaries. See [AGENTS.md](./AGENTS.md) for detailed architecture principles and [README.md](./README.md) for the high-level structure.

### Key Principles

1. **No cross-subsystem hidden state** — all communication goes through explicit interfaces
2. **Independently removable packages** — each subsystem can be removed without breaking the rest
3. **Efficiency by default** — designed for small models and constrained context windows
4. **Modularity over convenience** — structure matters for long-term maintainability

### Package Overview

| Package | Description |
|---------|-------------|
| `@butterfly/core` | Config loading, logging, dotenv, workspace utilities |
| `@butterfly/session` | Session state, message types, filesystem/SQLite storage |
| `@butterfly/tools` | File system tools, tool registry, MCP server integration |
| `@butterfly/llm` | LLM client adapters (OpenAI, Anthropic, Gemini), response parsing |
| `@butterfly/context` | SCE (Smart Context Engine), COE (Context Optimization Engine), tokenizer |
| `@butterfly/agent` | Agent loop, prompt building, model router, subagent delegation |
| `@butterfly/server` | HTTP server, event bus, session manager, run-state, REST routes |
| `@butterfly/acp` | Agent Client Protocol integration for IDE/CLI clients |
| `@butterfly/server-app` | Thin HTTP server entry point |

## Contribution Workflow

### 1. Find or Create an Issue

Before starting work, check if there's an existing issue for what you want to work on. If not, create one. This helps avoid duplicate effort and ensures alignment with project goals.

### 2. Create a Branch

```bash
git checkout -b feat/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

Branch naming conventions:
- `feat/` — new features
- `fix/` — bug fixes
- `docs/` — documentation improvements
- `refactor/` — code refactoring
- `test/` — test improvements

### 3. Make Your Changes

- Follow existing code style (Biome enforces formatting)
- Keep changes focused — one feature/bug per branch
- Add or update tests as needed
- Update documentation if applicable

### 4. Run Checks

Before submitting, ensure all checks pass:

```bash
pnpm typecheck   # No type errors
pnpm test        # All tests pass
pnpm lint        # No lint errors
```

### 5. Submit a Pull Request

1. Push your branch
2. Open a PR against `main`
3. Fill out the [PR template](./.github/PULL_REQUEST_TEMPLATE.md)
4. Link any related issues

### 6. Code Review

Maintainers will review your PR. Please:
- Respond to feedback promptly
- Make requested changes
- Keep the conversation constructive

## Code Style Guidelines

- **TypeScript**: Strict mode, ES2022 target, ESNext modules
- **Formatting**: Biome (auto-format with `pnpm format`)
- **Naming**: camelCase for variables/functions, PascalCase for classes/types, UPPER_CASE for constants
- **Imports**: Use workspace protocol for monorepo packages (`@butterfly/*`)
- **Error handling**: Use typed errors, no bare `throw`
- **Async**: Prefer `async/await` over raw promises
- **No process.env**: All environment variable access must go through `core/src/config.ts`

## Need Help?

- Open a [Discussion](https://github.com/butterfly-agent/butterfly-agent/discussions)
- Ask in the issue you're working on
- Read [AGENTS.md](./AGENTS.md) for architectural details

## Release Process

Maintainers handle releases. The project follows [Semantic Versioning](https://semver.org/).
