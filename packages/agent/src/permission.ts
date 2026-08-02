/**
 * Permission hook builder — converts ButterflyPermissionConfig into a runtime
 * permission hook for the agent loop.
 *
 * Extracted from factory.ts so it can be unit-tested independently.
 *
 * v2 features (OpenCode-compatible rulesets):
 *   - Wildcard pattern matching (`*` globs) for bash command rules and paths,
 *     e.g. `"git *": "allow"` or `"npm run *": "ask"`.
 *   - Per-session "always allow" memory: when a user answers the HITL prompt
 *     with "always", the rule is remembered for the rest of that session so the
 *     loop stops asking for identical operations.
 */

import type { ButterflyPermissionConfig } from "@butterfly/core"
import type { AskUserCallback } from "./ask-user"
import { permissionCategoryForTool } from "./ask-user"
import type { PermissionHook } from "./loop"

/** Convert a glob-style pattern (* and ? wildcards) to a regex. */
export function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`)
}

/** Wildcard match — true if `value` matches `pattern` (globs allowed). */
export function matchesPattern(pattern: string, value: string): boolean {
  try {
    return patternToRegExp(pattern).test(value)
  } catch {
    return false
  }
}

/**
 * Build a permission hook from the ButterflyPermissionConfig.
 *
 * Default behavior when no config is provided: allow all operations.
 * When config is present, the rules are:
 * - `edit: "allow"` — allow all write/patch/delete tools
 * - `edit: "deny"` — block all write/patch/delete tools
 * - `edit: "ask"` — require onAskUser callback; deny if unavailable
 * - `bash` — glob-pattern-based bash command rules (same allow/deny/ask tri-state)
 *
 * Subagent delegation and read tools are always allowed.
 */
export function buildPermissionHook(
  config: ButterflyPermissionConfig | undefined,
  onAskUser: AskUserCallback | undefined,
): PermissionHook {
  // No config = no restrictions. Default to allow.
  if (!config || (!config.edit && !config.bash)) {
    return async () => ({ allowed: true })
  }

  const editRule = config.edit ?? "allow"
  const bashRules = config.bash ?? {}

  // Per-session approved rules — keyed by sessionId, remembered "always" answers.
  const approved = new Map<string, Array<{ tool: string; pattern: string }>>()

  const isApproved = (sessionId: string | undefined, tool: string, value: string): boolean => {
    if (!sessionId) return false
    const rules = approved.get(sessionId)
    if (!rules) return false
    return rules.some((r) => r.tool === tool && matchesPattern(r.pattern, value))
  }

  const rememberApproval = (sessionId: string | undefined, tool: string, pattern: string): void => {
    if (!sessionId) return
    const rules = approved.get(sessionId) ?? []
    rules.push({ tool, pattern })
    approved.set(sessionId, rules)
  }

  return async (toolName, input, sessionId) => {
    // File mutation tools: write, patch, diff_patch, delete, rollback, apply_patch
    if (
      toolName === "write" ||
      toolName === "patch" ||
      toolName === "diff_patch" ||
      toolName === "apply_patch" ||
      toolName === "delete" ||
      toolName === "rollback"
    ) {
      const path = String(input.path ?? "")
      if (isApproved(sessionId, toolName, path)) return { allowed: true }
      return resolveEditPermission(editRule, toolName, input, onAskUser, (answer) => {
        if (answer === "always") rememberApproval(sessionId, toolName, path || "*")
      })
    }

    // Bash/exec tools: check against wildcard patterns, then fall back to edit rule.
    if (toolName === "bash") {
      const command = String(input.command ?? "")
      for (const [pattern, rule] of Object.entries(bashRules)) {
        if (matchesPattern(pattern, command)) {
          if (rule === "allow") return { allowed: true }
          if (rule === "deny") {
            return {
              allowed: false,
              reason: `Bash command "${command.slice(0, 80)}" denied by config pattern "${pattern}".`,
            }
          }
          // ask
          if (onAskUser) {
            if (isApproved(sessionId, toolName, command)) return { allowed: true }
            const answer = await onAskUser(
              `Allow bash command: ${command.slice(0, 200)}?`,
              ["yes", "no", "always"],
              { tool: toolName, category: "bash" },
            )
            if (answer === "yes" || answer === "always") {
              if (answer === "always") rememberApproval(sessionId, toolName, pattern)
              return { allowed: true }
            }
            return { allowed: false, reason: "User denied bash command." }
          }
          return {
            allowed: false,
            reason: "Bash requires user approval but no onAskUser callback is configured.",
          }
        }
      }
      // No matching bash rule — fall back to edit rule behavior.
      return resolveEditPermission(editRule, "bash", { command }, onAskUser, (answer) => {
        if (answer === "always") rememberApproval(sessionId, toolName, command || "*")
      })
    }

    // Subagent delegation and read tools: always allowed
    return { allowed: true }
  }
}

async function resolveEditPermission(
  rule: "allow" | "deny" | "ask",
  toolName: string,
  input: Record<string, unknown>,
  onAskUser: AskUserCallback | undefined,
  onAlways: (answer: string) => void,
): Promise<{ allowed: boolean; reason?: string }> {
  if (rule === "allow") return { allowed: true }
  if (rule === "deny") return { allowed: false, reason: `File editing is denied by config.` }

  // "ask": requires human-in-the-loop
  if (onAskUser) {
    const path = String(input.path ?? "unknown file")
    const answer = await onAskUser(`Allow ${toolName} on "${path}"?`, ["yes", "no", "always"], {
      tool: toolName,
      category: permissionCategoryForTool(toolName),
    })
    if (answer === "yes" || answer === "always") {
      if (answer === "always") onAlways(answer)
      return { allowed: true }
    }
    return { allowed: false, reason: `User denied ${toolName} on "${path}".` }
  }

  return {
    allowed: false,
    reason: `File editing requires user approval but no onAskUser callback is configured.`,
  }
}
