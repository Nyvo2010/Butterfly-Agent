/**
 * Human-in-the-loop callback types shared by the agent loop, permission hook, and server.
 *
 * Canonical definitions live in @butterfly/tools to avoid duplicate types across packages.
 */

import type { AskUserCallback, PermissionCategory } from "@butterfly/tools"

export type { AskUserCallback, PermissionCategory }

export interface AskUserContext {
  tool: string
  category: PermissionCategory
}

/** Map a tool name to a permission category for client UI routing. */
export function permissionCategoryForTool(toolName: string): PermissionCategory {
  if (toolName === "bash") return "bash"
  if (toolName === "question" || toolName === "ask_user") return "ask_user"
  if (toolName === "plan_exit") return "plan"
  if (
    toolName === "write" ||
    toolName === "patch" ||
    toolName === "diff_patch" ||
    toolName === "apply_patch" ||
    toolName === "delete" ||
    toolName === "rollback"
  ) {
    return "edit"
  }
  return "ask_user"
}
