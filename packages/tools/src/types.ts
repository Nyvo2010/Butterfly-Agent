// Public types for the Tool System. The Agent Loop (Phase C) consumes ToolResult
// after Tool.execute resolves; Mode-aware filtering is handled by the Agent package
// via ToolRegistry.listAllowed(kinds) to keep this package free of session coupling.

import { realpath } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

export type ToolKind = "read" | "write" | "exec" | "delegate"

/** Permission category for HITL prompts — mirrors @butterfly/agent PermissionCategory. */
export type PermissionCategory = "ask_user" | "edit" | "bash" | "plan"

/** Human-in-the-loop callback — shape matches @butterfly/agent AskUserCallback. */
export type AskUserCallback = (
  question: string,
  options?: string[],
  context?: { tool: string; category: PermissionCategory },
) => Promise<string | null>

/** Context passed to every tool invocation. */
export interface ToolContext {
  /** Working directory; relative paths in `input` resolve against this. */
  cwd: string
  /** Caller-provided abort signal for cancellable tools. */
  signal?: AbortSignal
  /** Optional environment overrides. */
  env?: Record<string, string>
  /**
   * Allowed workspace roots. If set, every file access must resolve within one
   * of these directories. Provides defense against path traversal attacks.
   */
  workspaceRoots?: string[]
  /**
   * Directory basenames to skip during walk operations (glob/grep).
   * Merged with the built-in skip list (node_modules, .git, dist, etc.).
   */
  skipDirs?: string[]
  /** Current subagent nesting depth (0 = top-level). */
  subagentDepth?: number
  /**
   * Callback to ask the user a question (human-in-the-loop).
   * When set, tools can pause execution to get user input.
   * Returns the user's answer as a string, or null if cancelled.
   * OpenCode-compatible: mirrors OpenCode's question tool pattern.
   */
  onAskUser?: AskUserCallback
}

/**
 * Check if a resolved path falls within any of the allowed workspace roots.
 * Workspace roots are resolved to absolute paths before comparison.
 * Resolves symlinks to detect path traversal through symlink targets.
 */
export async function isPathInWorkspace(
  target: string,
  workspaceRoots: string[],
): Promise<boolean> {
  const resolved = resolve(target)
  // Use for-of to short-circuit: stop checking once we find a match.
  for (const root of workspaceRoots) {
    const normalizedRoot = resolve(root)
    try {
      // Resolve the root to its real path (following symlinks).
      const resolvedRoot = await realpath(normalizedRoot)
      // Use stat() to check if the target exists. realpath() throws on
      // non-existent paths, which would break file creation tools (write,
      // patch, etc.). For non-existent paths, we resolve the parent directory
      // and verify it's within the workspace.
      let resolvedTarget: string
      try {
        resolvedTarget = await realpath(resolved)
      } catch {
        // Target doesn't exist yet (e.g., writing a new file). Resolve
        // its parent directory via realpath to check if we're in-bounds.
        const parent = dirname(resolved)
        try {
          resolvedTarget = await realpath(parent)
        } catch {
          // Parent doesn't exist either — can't validate. Deny.
          continue
        }
      }
      const rel = relative(resolvedRoot, resolvedTarget)
      if (rel === "" || !rel.startsWith("..")) return true
    } catch {
      // Symlink resolution failed — not a match.
    }
  }
  return false
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
  /** JSON Schema describing accepted `input` keys. Does NOT enforce at runtime; callers must validate input before execute. */
  readonly inputSchema: Record<string, unknown>
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult<O>>
}
