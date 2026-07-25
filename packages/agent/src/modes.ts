import type { Mode } from "@butterfly/session"
import type { ToolKind } from "@butterfly/tools"

function assertNever(x: never): never {
  throw new Error(`Unexpected mode: ${x}`)
}

/**
 * Maps session Mode to the allowed tool kinds.
 * - Plan: read-only — file inspection only, no writes or execution.
 * - Build: full access — read + write + exec + delegate (all tools).
 */
export function kindsForMode(mode: Mode): ToolKind[] {
  switch (mode) {
    case "plan":
      return ["read"]
    case "build":
      return ["read", "write", "exec", "delegate"]
    default:
      return assertNever(mode)
  }
}

export function modePolicyText(mode: Mode): string {
  switch (mode) {
    case "plan":
      return "Plan mode is read-only. Return a structured plan; do NOT call write/patch/bash."
    case "build":
      return "Build mode has full tool access. Make concrete edits and delegate to subagents as needed."
    default:
      return assertNever(mode)
  }
}
