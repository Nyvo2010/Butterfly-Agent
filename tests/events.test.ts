/**
 * Frontend-facing bus event tests.
 *
 * Verifies the events a client consumes to render live state (OpenCode parity):
 *   - todo.updated: emitted by the agent factory when the loop maintains a
 *     todo list (via the todowrite tool).
 *   - message.updated / message.removed: emitted by editMessage / retry.
 */
import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "../core/src/butterfly-config"
import { createAgent } from "../packages/agent/src/factory"
import { GPTTokenizer } from "../packages/context/src"
import { EventBus } from "../packages/server/src/bus"
import { InMemorySessionStore } from "../packages/session/src"
import { createSession } from "../packages/session/src/types"
import { MockLLMClient, textResponse, toolCallResponse } from "./mock-llm"

describe("Frontend bus events — todo.updated via agent factory", () => {
  it("emits todo.updated when the loop maintains a todo list", async () => {
    const tokenizer = new GPTTokenizer()
    tokenizer.warmup()
    const store = new InMemorySessionStore()
    const bus = new EventBus()
    const events: Array<{ kind: string; sessionId?: string; data?: unknown }> = []
    bus.subscribe((e) => events.push(e))

    // The factory registers a session-scoped todowrite tool wired to its
    // own todosRef; the loop syncs todosRef -> session.todos each iteration.

    // Mock LLM: writes todos (twice, with an update between) then replies.
    // The second write should preserve ids for items matched by content and
    // assign a fresh id to the new item — the client-reconciliation contract.
    const mock = new MockLLMClient([
      toolCallResponse([
        {
          id: "tc-todo",
          name: "todowrite",
          input: {
            todos: [
              { content: "step one", status: "in_progress", priority: "high" },
              { content: "step two", status: "pending", priority: "medium" },
            ],
          },
        },
      ]),
      toolCallResponse([
        {
          id: "tc-todo-2",
          name: "todowrite",
          input: {
            todos: [
              { content: "step one", status: "completed", priority: "high" },
              { content: "step three", status: "in_progress", priority: "medium" },
            ],
          },
        },
      ]),
      textResponse("done"),
    ])

    const agent = await createAgent({
      cwd: process.cwd(),
      llm: mock as never,
      tokenizer,
      store,
      config: DEFAULT_CONFIG,
      bus: {
        emit: (event) => bus.emit(event as never),
      },
    })

    const session = createSession("evt-todo", "build")
    await agent.loop.run({
      session,
      query: "track my work",
      cwd: process.cwd(),
      maxSteps: 3,
    })
    await agent.dispose()

    const todoEvents = events.filter((e) => e.kind === "todo.updated")
    expect(todoEvents.length).toBeGreaterThanOrEqual(2)
    const first = todoEvents[0].data as { todos: Array<{ id: string; content: string }> }
    const second = todoEvents[1].data as { todos: Array<{ id: string; content: string }> }
    expect(first.todos[0].content).toBe("step one")
    expect(first.todos[1].content).toBe("step two")
    // Stable id reconciliation: "step one" keeps its id across the update,
    // the new item "step three" gets a different (fresh) id.
    expect(first.todos[0].id).toBeTruthy()
    expect(second.todos[0].id).toBe(first.todos[0].id)
    expect(second.todos[0].content).toBe("step one")
    expect(second.todos[1].content).toBe("step three")
    expect(second.todos[1].id).not.toBe(first.todos[0].id)
    expect(second.todos[1].id).not.toBe(first.todos[1].id)
  })

  it("does NOT emit todo.updated when the agent never uses todos", async () => {
    const tokenizer = new GPTTokenizer()
    tokenizer.warmup()
    const store = new InMemorySessionStore()
    const bus = new EventBus()
    const events: Array<{ kind: string }> = []
    bus.subscribe((e) => events.push(e))

    const mock = new MockLLMClient([textResponse("plain answer")])
    const agent = await createAgent({
      cwd: process.cwd(),
      llm: mock as never,
      tokenizer,
      store,
      config: DEFAULT_CONFIG,
      bus: {
        emit: (event) => bus.emit(event as never),
      },
    })

    const session = createSession("evt-no-todo", "build")
    await agent.loop.run({
      session,
      query: "just answer",
      cwd: process.cwd(),
      maxSteps: 3,
    })
    await agent.dispose()

    expect(events.filter((e) => e.kind === "todo.updated")).toHaveLength(0)
  })
})
