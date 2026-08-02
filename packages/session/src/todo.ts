/**
 * Session Todo management — persisted as part of SessionState.todos.
 *
 * Todos live on the SessionState and are saved/loaded with the session
 * by the SessionStore. This eliminates data loss on restart and ensures
 * todos are shared across server instances when using SQLite storage.
 *
 * The factory (packages/agent/src/factory.ts) creates a mutable ref
 * that the todowrite tool reads/writes; the agent loop syncs the ref
 * into the session before each save so todos are persisted.
 */

export interface TodoItem {
  /** Stable id — assigned by the todowrite tool, used by clients to
   *  reconcile todo.updated events (OpenCode parity). */
  id?: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
}

/**
 * Persist todos into a session state. Pure function — returns a new state.
 */
export function setSessionTodos(
  session: { todos?: TodoItem[] },
  todos: TodoItem[],
): { todos: TodoItem[] } {
  return { ...session, todos }
}

/**
 * Clear todos from a session state. Pure function.
 */
export function clearSessionTodos(session: { todos?: TodoItem[] }): { todos?: TodoItem[] } {
  const { todos: _, ...rest } = session as { todos?: TodoItem[]; [key: string]: unknown }
  return rest
}
