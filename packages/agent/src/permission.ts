/**
 * Permission hook builder — converts ButterflyPermissionConfig into a
 * runtime permission hook for the agent loop.
 *
 * Extracted from factory.ts so it can be unit-tested independently.
 */

import type { ButterflyPermissionConfig } from "@butterfly/core"
import type { PermissionHook } from "./loop"

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
  onAskUser: ((question: string, options?: string[]) => Promise<string | null>) | undefined,
): PermissionHook {
  // No config = no restrictions. Default to allow.
  if (!config || (!config.edit && !config.bash)) {
    return async () => ({ allowed: true })
  }

  const editRule = config.edit ?? "allow"
  const bashRules = config.bash ?? {}

  return async (toolName, input) => {
    // File mutation tools: write, patch, diff_patch, delete, rollback
    if (
      toolName === "write" ||
      toolName === "patch" ||
      toolName === "diff_patch" ||
      toolName === "delete" ||
      toolName === "rollback"
    ) {
      return resolveEditPermission(editRule, toolName, input, onAskUser)
    }

    // Bash/exec tools: check against glob patterns, then fall back to edit rule
    if (toolName === "bash") {
      const command = String((input as Record<string, unknown>).command ?? "")
      for (const [pattern, rule] of Object.entries(bashRules)) {
        if (command.includes(pattern)) {
          return resolveBashPermission(rule, command, onAskUser, pattern)
        }
      }
      // No matching bash rule — fall back to edit rule behavior
      return resolveEditPermission(
        editRule,
        "bash",
        { command } as Record<string, unknown>,
        onAskUser,
      )
    }

    // Subagent delegation and read tools: always allowed
    return { allowed: true }
  }
}

async function resolveEditPermission(
  rule: "allow" | "deny" | "ask",
  toolName: string,
  input: Record<string, unknown>,
  onAskUser: ((question: string, options?: string[]) => Promise<string | null>) | undefined,
): Promise<{ allowed: boolean; reason?: string }> {
  if (rule === "allow") return { allowed: true }
  if (rule === "deny") return { allowed: false, reason: `File editing is denied by config.` }

  // "ask": requires human-in-the-loop
  if (onAskUser) {
    const path = String(input.path ?? "unknown file")
    const answer = await onAskUser(`Allow ${toolName} on "${path}"?`, ["yes", "no"])
    if (answer === "yes") return { allowed: true }
    return { allowed: false, reason: `User denied ${toolName} on "${path}".` }
  }

  return {
    allowed: false,
    reason: `File editing requires user approval but no onAskUser callback is configured.`,
  }
}

async function resolveBashPermission(
  rule: "allow" | "deny" | "ask",
  command: string,
  onAskUser: ((question: string, options?: string[]) => Promise<string | null>) | undefined,
  pattern?: string,
): Promise<{ allowed: boolean; reason?: string }> {
  if (rule === "allow") return { allowed: true }
  if (rule === "deny") {
    const reason = pattern
      ? `Bash command "${command.slice(0, 80)}" denied by config pattern "${pattern}".`
      : `Bash execution is denied by config.`
    return { allowed: false, reason }
  }

  // "ask"
  if (onAskUser) {
    const answer = await onAskUser(`Allow bash command: ${command.slice(0, 200)}?`, ["yes", "no"])
    if (answer === "yes") return { allowed: true }
    return { allowed: false, reason: "User denied bash command." }
  }

  return {
    allowed: false,
    reason: "Bash requires user approval but no onAskUser callback is configured.",
  }
}
