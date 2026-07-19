// Public types for the Tool System. The Agent Loop (Phase C) consumes ToolResult
// after Tool.execute resolves; Mode-aware filtering is handled by the Agent package
// via ToolRegistry.listAllowed(kinds) to keep this package free of session coupling.

export type ToolKind = "read" | "write" | "exec" | "delegate"

/** Context passed to every tool invocation. */
export interface ToolContext {
  /** Working directory; relative paths in `input` resolve against this. */
  cwd: string
  /** Caller-provided abort signal for cancellable tools. */
  signal?: AbortSignal
  /** Optional environment overrides. */
  env?: Record<string, string>
}

/**
 * Discriminated union for any tool's outcome. The Agent Loop treats
 * `kind: "err"` as the escalation trigger per MVP-SCOPE §8.
 */
export type ToolResult<T = unknown> = { kind: "ok"; output: T } | { kind: "err"; message: string }

export interface Tool<O = unknown> {
  readonly name: string
  readonly description: string
  readonly kind: ToolKind
  /** JSON Schema describing accepted `input` keys. */
  readonly inputSchema: Record<string, unknown>
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult<O>>
}
