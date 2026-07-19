import type { Mode } from "@butterfly/session"
import type { ToolKind } from "@butterfly/tools"

/**
 * Maps session Mode to the allowed tool kinds.
 * - Plan: read-only — file inspection only, no writes or execution.
 * - Build: full access — read + write + exec; delegate (subagent) NOT exposed.
 * - Orchestrator: read + delegate (spawn_subagent); no direct writes.
 */
export function kindsForMode(mode: Mode): ToolKind[] {
  switch (mode) {
    case "plan":
      return ["read"]
    case "build":
      return ["read", "write", "exec"]
    case "orchestrator":
      return ["read", "delegate"]
  }
}

export function modePolicyText(mode: Mode): string {
  switch (mode) {
    case "plan":
      return "Plan mode is read-only. Return a structured plan; do NOT call write/patch/bash."
    case "build":
      return "Build mode has full tool access except subagent delegation. Make concrete edits."
    case "orchestrator":
      return "Orchestrator mode is read-only. Delegate work via subagent; do NOT edit files directly."
  }
}
