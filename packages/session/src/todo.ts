/**
 * Session Todo management — persistent todo list per session.
 * Mirrors OpenCode's SessionTodo service.
 */

import type { SessionStore } from "./store"

export interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
}

/**
 * In-memory todo store. For production, this should be persisted alongside
 * the session in the SQLite/Filesystem stores.
 */
const todoStore = new Map<string, TodoItem[]>()

export function getTodos(sessionId: string): TodoItem[] {
  return todoStore.get(sessionId) ?? []
}

export function updateTodos(
  sessionId: string,
  todos: TodoItem[],
  store?: SessionStore,
): void {
  todoStore.set(sessionId, todos)
  // Persist alongside session if store supports it.
  // For now, todos live in memory only and are lost on restart.
  void store
}

export function clearTodos(sessionId: string): void {
  todoStore.delete(sessionId)
}
