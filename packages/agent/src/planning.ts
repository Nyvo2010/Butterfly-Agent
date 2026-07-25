/**
 * TODO-driven planning module.
 *
 * Extracts a structured plan from model output and tracks completion.
 * The plan is injected into the system prompt so the model sees its own
 * progress and avoids repeating completed work.
 *
 * This is inspired by SmallCode's Bootstrap + Quality Monitor pattern
 * and OpenCode's plan mode, adapted for Butterfly's multi-tier architecture.
 */

import { log } from "@butterfly/core"

export interface TodoItem {
  /** Unique identifier for this todo. */
  id: string
  /** Human-readable task description. */
  task: string
  /** Whether this todo is completed. */
  completed: boolean
  /** When the todo was created (ISO 8601). */
  createdAt: string
  /** When the todo was marked complete, if completed. */
  completedAt?: string
}

export interface Plan {
  /** Ordered list of todo items. */
  todos: TodoItem[]
  /** When the plan was created. */
  createdAt: string
  /** Brief description of the overall goal. */
  goal: string
}

/**
 * Parse a plan from a model's text response. Looks for markdown-style
 * checklists and numbered lists that describe a task breakdown.
 *
 * Heuristic: finds lines matching `- [ ] task` or `1. task` patterns
 * and treats them as todo items.
 */
export function extractPlanFromText(text: string, goal: string): Plan {
  const todos: TodoItem[] = []
  const now = new Date().toISOString()

  // Match markdown checkboxes: - [ ] task or - [x] task
  const checkboxRe = /^[-*]\s+\[([ xX])\]\s+(.+)$/gm
  let m = checkboxRe.exec(text)
  while (m !== null) {
    const completed = m[1].toLowerCase() === "x"
    todos.push({
      id: `todo-${todos.length}`,
      task: m[2].trim(),
      completed,
      createdAt: now,
      completedAt: completed ? now : undefined,
    })
    m = checkboxRe.exec(text)
  }

  // If no checkboxes found, try numbered lists: 1. task
  if (todos.length === 0) {
    const numRe = /^\d+\.\s+(.+)$/gm
    let nm = numRe.exec(text)
    while (nm !== null) {
      todos.push({
        id: `todo-${todos.length}`,
        task: nm[1].trim(),
        completed: false,
        createdAt: now,
      })
      nm = numRe.exec(text)
    }
  }

  return { todos, createdAt: now, goal }
}

/**
 * Format a plan as text for injection into the system prompt.
 */
export function formatPlanForPrompt(plan: Plan): string {
  if (plan.todos.length === 0) return ""
  const lines = ["CURRENT PLAN:", `Goal: ${plan.goal}`, ""]
  for (const todo of plan.todos) {
    const marker = todo.completed ? "[x]" : "[ ]"
    lines.push(`  - ${marker} ${todo.task}`)
  }
  lines.push("", "Progress: mark completed items with [x]. Update the plan as needed.")
  return lines.join("\n")
}

/**
 * Track plan completion based on tool call results.
 * Returns updated todos with auto-completion heuristics.
 *
 * Heuristics:
 * - write/patch/delete on a file mentioned in a todo → mark that todo complete
 * - bash command mentions a todo task keyword → mark it complete
 * - subagent returns success → mark its task complete
 */
export function updatePlanFromToolResult(
  plan: Plan,
  toolName: string,
  input: Record<string, unknown>,
  success: boolean,
): Plan {
  if (!success) return plan

  const now = new Date().toISOString()
  const updated = plan.todos.map((todo) => {
    if (todo.completed) return todo

    const taskLower = todo.task.toLowerCase()
    let matched = false

    // Check if the tool's target path matches a todo description.
    const path = String(input.path ?? "")
    if (path && taskLower.includes(path.toLowerCase())) {
      matched = true
    }

    // Check if a subagent task matches a todo description.
    const task = String(input.task ?? "")
    if (task && todo.task.toLowerCase().includes(task.toLowerCase().slice(0, 30))) {
      matched = true
    }

    if (matched) {
      log("debug", "planning.auto_complete", { todo: todo.task, tool: toolName })
      return { ...todo, completed: true, completedAt: now }
    }
    return todo
  })

  return { ...plan, todos: updated }
}

/**
 * Get a summary of plan progress for logging and UI display.
 */
export function planProgress(plan: Plan): { total: number; completed: number; remaining: number } {
  const total = plan.todos.length
  const completed = plan.todos.filter((t) => t.completed).length
  return { total, completed, remaining: total - completed }
}
