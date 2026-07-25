# Changelog

All notable changes to Butterfly Agent will be documented in this file.

## [0.1.0] — Unreleased

### Added

- Initial release of Butterfly Agent
- Modular agent system with model tiering and automatic escalation
- 17 filesystem and execution tools (read, write, patch, delete, diff/patch, glob, grep, list, bash, background bash, LSP, subagent, rollback)
- Smart Context Engine (SCE) with multi-strategy context gathering
- Context Optimization Engine (COE) with token budget management
- Vercel AI SDK adapter with streaming support and retry logic
- Opencode-compatible configuration system with JSONC support
- MCP (Model Context Protocol) server integration
- Plugin system for extensible tool capabilities
- Session persistence with atomic writes and path traversal protection
- LSP integration for go-to-definition, references, and diagnostics
- Subagent delegation for parallel task execution
- Permission hooks for destructive operation control
- Structured JSON logging with configurable levels
- TypeScript strict mode throughout

[0.1.0]: https://github.com/butterfly-agent/butterfly-agent/releases/tag/v0.1.0
