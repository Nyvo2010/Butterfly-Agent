import type { Tool, ToolContext, ToolResult } from "../types"

/** Mirrors OpenCode's TodoItem shape. Structurally compatible with @butterfly/session TodoItem. */
export interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
}

export interface TodowriteToolDeps {
  /** Read the current todo list for the active session. */
  getTodos: () => TodoItem[]
  /** Persist an updated todo list for the active session. */
  updateTodos: (todos: TodoItem[]) => void
}

/**
 * Create a todowrite tool wired to session-scoped todo state.
 *
 * Rules (from OpenCode):
 * - Use proactively for 3+ distinct steps
 * - Keep exactly one "in_progress" while work remains
 * - Mark completed only after required work is done
 * - Update status in real time; don't batch completions
 */
export function createTodowriteTool(deps: TodowriteToolDeps): Tool {
  return {
    name: "todowrite",
    description:
      "Create and maintain a structured task list for the current coding session. " +
      "Use it to track progress during multi-step work and keep todo statuses current. " +
      "States: pending, in_progress, completed, cancelled. " +
      "Exactly one item in_progress at a time.",
    kind: "write",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Task description" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
                description: "Task status",
              },
              priority: {
                type: "string",
                enum: ["high", "medium", "low"],
                description: "Task priority",
                default: "medium",
              },
            },
            required: ["content", "status"],
          },
          description: "The updated todo list",
        },
      },
      required: ["todos"],
    },
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const rawTodos = input.todos as Array<Record<string, unknown>> | undefined
      if (!Array.isArray(rawTodos)) {
        return { kind: "err", message: "todos must be an array" }
      }

      const todos: TodoItem[] = rawTodos.map((t) => ({
        content: String(t.content ?? ""),
        status: (t.status as TodoItem["status"]) ?? "pending",
        priority: (t.priority as TodoItem["priority"]) ?? "medium",
      }))

      // Validate: at most one in_progress
      const inProgress = todos.filter((t) => t.status === "in_progress")
      if (inProgress.length > 1) {
        return {
          kind: "err",
          message:
            `Cannot have ${inProgress.length} items in_progress. ` +
            "Keep exactly one item in_progress at a time.",
        }
      }

      deps.updateTodos(todos)

      const summary = todos
        .filter((t) => t.status === "pending" || t.status === "in_progress")
        .map((t) => `  - [${t.status === "in_progress" ? "►" : " "}] ${t.content}`)
        .join("\n")

      const completed = todos.filter((t) => t.status === "completed").length
      return {
        kind: "ok",
        output:
          `Todo list updated (${todos.length} items, ${completed} completed):\n${summary}`,
      }
    },
  }
}
