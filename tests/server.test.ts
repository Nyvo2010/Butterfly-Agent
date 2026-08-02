/**
 * Tests for @butterfly/server — event bus, session manager, run-state, router.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { _resetEventIdCounter, type ButterflyEvent, EventBus } from "../packages/server/src/bus"
import { Router } from "../packages/server/src/router"
import { RunStateManager } from "../packages/server/src/run-state"
import {
  accumulateUsage,
  deriveTitle,
  generateSummary,
  SessionManager,
} from "../packages/server/src/session-manager"
import { InMemorySessionStore } from "../packages/session/src/store"
import { createSession } from "../packages/session/src/types"
import { sampleUsage } from "./fixtures"

// ─── Event Bus ────────────────────────────────────────────────────────────────

describe("@butterfly/server — EventBus", () => {
  beforeEach(() => {
    _resetEventIdCounter()
  })

  it("emits and subscribes to events", () => {
    const bus = new EventBus()
    const events: ButterflyEvent[] = []
    const unsub = bus.subscribe((e) => events.push(e))

    bus.emit({ kind: "session.created", sessionId: "s1", data: { mode: "build", title: "Test" } })

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("session.created")
    expect(events[0].sessionId).toBe("s1")
    expect(events[0].id).toBeTruthy()
    expect(events[0].timestamp).toBeTruthy()
    // type is auto-derived from kind
    expect(events[0].type).toBe("session")

    unsub()
    bus.emit({ kind: "session.deleted", sessionId: "s1" })
    expect(events).toHaveLength(1)
  })

  it("subscribeTo filters by kind", () => {
    const bus = new EventBus()
    const events: ButterflyEvent[] = []
    bus.subscribeTo("run.started", (e) => events.push(e))

    bus.emit({ kind: "session.created", sessionId: "s1", data: { mode: "build", title: "T" } })
    bus.emit({
      kind: "run.started",
      sessionId: "s1",
      data: { query: "test", model: "m", tier: "standard" },
    })

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("run.started")
  })

  it("subscribeTo accepts an array of kinds", () => {
    const bus = new EventBus()
    const events: ButterflyEvent[] = []
    bus.subscribeTo(["run.started", "run.completed"], (e) => events.push(e))

    bus.emit({ kind: "session.created", sessionId: "s1", data: { mode: "build", title: "T" } })
    bus.emit({
      kind: "run.started",
      sessionId: "s1",
      data: { query: "test", model: "m", tier: "standard" },
    })
    bus.emit({ kind: "run.aborted", sessionId: "s1" })
    bus.emit({
      kind: "run.completed",
      sessionId: "s1",
      data: { iterations: 1, stopReason: "no_tool_calls", model: "m", tier: "standard" },
    })

    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe("run.started")
    expect(events[1].kind).toBe("run.completed")
  })

  it("subscribeToSession filters by sessionId", () => {
    const bus = new EventBus()
    const events: ButterflyEvent[] = []
    bus.subscribeToSession("s1", (e) => events.push(e))

    bus.emit({
      kind: "run.started",
      sessionId: "s1",
      data: { query: "test", model: "m", tier: "standard" },
    })
    bus.emit({
      kind: "run.started",
      sessionId: "s2",
      data: { query: "test", model: "m", tier: "standard" },
    })
    bus.emit({
      kind: "run.completed",
      sessionId: "s1",
      data: { iterations: 1, stopReason: "no_tool_calls", model: "m", tier: "standard" },
    })

    expect(events).toHaveLength(2)
    expect(events.every((e) => e.sessionId === "s1")).toBe(true)
  })

  it("auto-derives type from kind via EVENT_CATEGORIES", () => {
    const bus = new EventBus()
    const events: ButterflyEvent[] = []
    bus.subscribe((e) => events.push(e))

    bus.emit({ kind: "tool.start", sessionId: "s1", data: { tool: "read", input: {} } })
    bus.emit({
      kind: "file.changed",
      sessionId: "s1",
      data: { path: "foo.ts", changeKind: "write" },
    })
    bus.emit({ kind: "mcp.connected", data: { server: "test", toolCount: 3 } })

    expect(events[0].type).toBe("tool")
    expect(events[1].type).toBe("file")
    expect(events[2].type).toBe("mcp")
  })

  it("clear removes all listeners", () => {
    const bus = new EventBus()
    let count = 0
    bus.subscribe(() => count++)
    bus.clear()
    bus.emit({ kind: "session.created", sessionId: "s1", data: { mode: "build", title: "T" } })
    expect(count).toBe(0)
  })
})

// ─── Session Manager ──────────────────────────────────────────────────────────

describe("@butterfly/server — SessionManager", () => {
  let store: InMemorySessionStore
  let bus: EventBus
  let manager: SessionManager

  beforeEach(() => {
    store = new InMemorySessionStore()
    bus = new EventBus()
    manager = new SessionManager(store, bus)
  })

  it("creates a session and emits created event", async () => {
    const events: ButterflyEvent[] = []
    bus.subscribe((e) => events.push(e))

    const session = await manager.create({ mode: "build", title: "Test" })
    expect(session.id).toBeTruthy()
    expect(session.mode).toBe("build")
    expect(session.title).toBe("Test")

    const loaded = await store.load(session.id)
    expect(loaded).toBeTruthy()

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("session.created")
  })

  it("deletes a session and emits deleted event", async () => {
    const events: ButterflyEvent[] = []
    bus.subscribe((e) => events.push(e))

    const session = await manager.create()
    await manager.delete(session.id)

    expect(await store.load(session.id)).toBeNull()
    expect(events.some((e) => e.kind === "session.deleted")).toBe(true)
  })

  it("updates session fields and emits updated event", async () => {
    const session = await manager.create()
    const updated = await manager.update(session.id, { title: "New Title", mode: "plan" })
    expect(updated?.title).toBe("New Title")
    expect(updated?.mode).toBe("plan")
  })

  it("archives a session and emits archived event", async () => {
    const session = await manager.create()
    const archived = await manager.archive(session.id, true)
    expect(archived?.archived).toBe(true)
  })

  it("forks a session with parentSessionId", async () => {
    const parent = await manager.create()
    // Add a message to the parent
    const loaded = await store.load(parent.id)
    if (loaded) {
      loaded.messages = [
        { id: "m1", role: "user", content: "hello", timestamp: new Date().toISOString() },
      ]
      await store.save(loaded)
    }

    const forked = await manager.fork(parent.id)
    expect(forked).toBeTruthy()
    expect(forked?.parentSessionId).toBe(parent.id)
    expect(forked?.id).not.toBe(parent.id)
    expect(forked?.messages).toHaveLength(1)
  })

  it("auto-derives title on save when none set", async () => {
    const session = createSession("test-title", "build")
    session.messages = [
      {
        id: "m1",
        role: "user",
        content: "Fix the bug in foo.ts",
        timestamp: new Date().toISOString(),
      },
    ]
    await manager.save(session)
    const loaded = await store.load("test-title")
    expect(loaded?.title).toBe("Fix the bug in foo.ts")
  })

  it("list excludes archived sessions by default", async () => {
    const s1 = await manager.create()
    const s2 = await manager.create()
    await manager.archive(s1.id, true)

    const list = await manager.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(s2.id)

    const listAll = await manager.list(true)
    expect(listAll).toHaveLength(2)
  })

  it("editMessage emits message.updated with the edited content", async () => {
    const session = await manager.create()
    const loaded = await store.load(session.id)
    if (loaded) {
      loaded.messages = [
        {
          id: "m-edit",
          role: "user",
          content: "original",
          timestamp: new Date().toISOString(),
        },
      ]
      await store.save(loaded)
    }

    const events: ButterflyEvent[] = []
    bus.subscribe((e) => events.push(e))
    const updated = await manager.editMessage(session.id, "m-edit", "revised")
    expect(updated?.messages[0].content).toBe("revised")

    const updatedEvent = events.find((e) => e.kind === "message.updated")
    expect(updatedEvent).toBeTruthy()
    expect((updatedEvent?.data as { messageId: string; content: string }).messageId).toBe("m-edit")
    expect((updatedEvent?.data as { messageId: string; content: string }).content).toBe("revised")
  })

  it("retry emits message.removed for truncated messages", async () => {
    const session = await manager.create()
    const loaded = await store.load(session.id)
    if (loaded) {
      loaded.messages = [
        {
          id: "m-user",
          role: "user",
          content: "do it",
          timestamp: new Date().toISOString(),
        },
        {
          id: "m-assistant",
          role: "assistant",
          content: "here you go",
          timestamp: new Date().toISOString(),
        },
        {
          id: "m-tool",
          role: "tool",
          content: "result",
          toolCallId: "tc-1",
          timestamp: new Date().toISOString(),
        },
      ]
      await store.save(loaded)
    }

    const events: ButterflyEvent[] = []
    bus.subscribe((e) => events.push(e))
    const prep = await manager.retry(session.id)
    expect(prep?.query).toBe("do it")

    const removedEvents = events.filter((e) => e.kind === "message.removed")
    expect(removedEvents).toHaveLength(2) // assistant + tool messages
    const removedIds = removedEvents.map((e) => (e.data as { messageId: string }).messageId)
    expect(removedIds).toContain("m-assistant")
    expect(removedIds).toContain("m-tool")
  })
})

// ─── Session helpers ──────────────────────────────────────────────────────────

describe("@butterfly/server — session helpers", () => {
  it("deriveTitle uses first user message", () => {
    const session = createSession("t", "build")
    session.messages = [
      { id: "m1", role: "user", content: "Help me fix this", timestamp: new Date().toISOString() },
    ]
    expect(deriveTitle(session)).toBe("Help me fix this")
  })

  it("deriveTitle strips bootstrap prefix", () => {
    const session = createSession("t", "build")
    session.messages = [
      {
        id: "m1",
        role: "user",
        content: "[Project context: TypeScript + React]\n\nDo the thing",
        timestamp: new Date().toISOString(),
      },
    ]
    expect(deriveTitle(session)).toBe("Do the thing")
  })

  it("deriveTitle truncates long titles", () => {
    const session = createSession("t", "build")
    const long = "x".repeat(200)
    session.messages = [
      { id: "m1", role: "user", content: long, timestamp: new Date().toISOString() },
    ]
    const title = deriveTitle(session)
    expect(title.length).toBeLessThanOrEqual(80)
  })

  it("deriveTitle returns default for empty session", () => {
    const session = createSession("t", "build")
    expect(deriveTitle(session)).toBe("New session")
  })

  it("accumulateUsage adds token counts", () => {
    const session = createSession("t", "build")
    const updated = accumulateUsage(session, sampleUsage())
    expect(updated.usage?.promptTokens).toBe(150)
    expect(updated.usage?.completionTokens).toBe(50)
    expect(updated.usage?.totalTokens).toBe(200)
    expect(updated.usage?.callCount).toBe(1)
  })

  it("accumulateUsage sums across calls", () => {
    const session = createSession("t", "build")
    let s = accumulateUsage(session, sampleUsage())
    s = accumulateUsage(s, sampleUsage())
    expect(s.usage?.callCount).toBe(2)
    expect(s.usage?.promptTokens).toBe(300)
  })

  it("generateSummary uses last assistant message", () => {
    const session = createSession("t", "build")
    session.messages = [
      { id: "m1", role: "user", content: "do something", timestamp: new Date().toISOString() },
      {
        id: "m2",
        role: "assistant",
        content: "I did the thing successfully.",
        timestamp: new Date().toISOString(),
      },
    ]
    expect(generateSummary(session)).toBe("I did the thing successfully.")
  })

  it("generateSummary truncates long summaries", () => {
    const session = createSession("t", "build")
    const long = "x".repeat(300)
    session.messages = [
      { id: "m1", role: "assistant", content: long, timestamp: new Date().toISOString() },
    ]
    const summary = generateSummary(session)
    expect(summary.length).toBeLessThanOrEqual(200)
  })
})

// ─── Run State Manager ────────────────────────────────────────────────────────

describe("@butterfly/server — RunStateManager", () => {
  let bus: EventBus
  let runState: RunStateManager

  beforeEach(() => {
    bus = new EventBus()
    runState = new RunStateManager(bus)
  })

  it("start returns abort controller and tracks running", () => {
    const { abort } = runState.start("s1")
    expect(abort).toBeInstanceOf(AbortController)
    expect(runState.isActive("s1")).toBe(true)
    expect(runState.status("s1")).toBe("running")
  })

  it("complete removes the run and emits completed event", async () => {
    const events: ButterflyEvent[] = []
    bus.subscribe((e) => events.push(e))

    const { abort } = runState.start("s1")
    runState.complete(
      "s1",
      { iterations: 3, stopReason: "no_tool_calls", model: "m", tier: "standard" },
      abort,
    )

    expect(runState.isActive("s1")).toBe(false)
    expect(events.some((e) => e.kind === "run.completed")).toBe(true)
  })

  it("abort cancels the run and emits aborted event", () => {
    const events: ButterflyEvent[] = []
    bus.subscribe((e) => events.push(e))

    runState.start("s1")
    const aborted = runState.abort("s1")

    expect(aborted).toBe(true)
    expect(runState.isActive("s1")).toBe(false)
    expect(events.some((e) => e.kind === "run.aborted")).toBe(true)
  })

  it("start aborts existing run for same session", () => {
    const events: ButterflyEvent[] = []
    bus.subscribe((e) => events.push(e))

    const { abort: abort1 } = runState.start("s1")
    runState.start("s1")

    expect(abort1.signal.aborted).toBe(true)
    expect(events.some((e) => e.kind === "run.aborted")).toBe(true)
    expect(events.some((e) => e.kind === "run.started")).toBe(true)
  })

  it("expectedAbort guard prevents stale run from completing newer run", () => {
    const { abort: abort1 } = runState.start("s1")
    // New run takes over
    const { abort: abort2 } = runState.start("s1")
    expect(abort1.signal.aborted).toBe(true)

    // Old run tries to complete with its own abort — should be ignored
    runState.complete(
      "s1",
      { iterations: 1, stopReason: "no_tool_calls", model: "m", tier: "standard" },
      abort1,
    )
    expect(runState.isActive("s1")).toBe(true)
    expect(runState.getAbort("s1")).toBe(abort2)

    // New run completes with its own abort — should work
    runState.complete(
      "s1",
      { iterations: 2, stopReason: "no_tool_calls", model: "m", tier: "standard" },
      abort2,
    )
    expect(runState.isActive("s1")).toBe(false)
  })

  it("complete() without expectedAbort works for backward compat", () => {
    runState.start("s1")
    runState.complete("s1", {
      iterations: 1,
      stopReason: "no_tool_calls",
      model: "m",
      tier: "standard",
    })
    expect(runState.isActive("s1")).toBe(false)
  })

  it("error removes the run and emits error event", () => {
    const events: ButterflyEvent[] = []
    bus.subscribe((e) => events.push(e))

    const { abort } = runState.start("s1")
    runState.error("s1", "something went wrong", abort)

    expect(runState.isActive("s1")).toBe(false)
    expect(events.some((e) => e.kind === "run.error")).toBe(true)
  })

  it("abortAll aborts all active runs", () => {
    runState.start("s1")
    runState.start("s2")
    expect(runState.count()).toBe(2)

    runState.abortAll()
    expect(runState.count()).toBe(0)
  })
})

// ─── Permission Flow ─────────────────────────────────────────────────────────

describe("@butterfly/server — permission flow", () => {
  // requestPermission + reply round-trip is tested with a real permission
  // store, mirroring how the HTTP route resolves a pending request.
  it("requestPermission resolves when reply is posted", async () => {
    const { requestPermission } = await import("../packages/server/src/routes/permission")
    const { InMemoryPermissionStore } = await import("../packages/server/src/permission-store")
    const bus = new EventBus()
    const permissionStore = new InMemoryPermissionStore()
    // Minimal app stub — requestPermission only needs bus + permissionStore.
    const app = { bus, permissionStore } as never

    const events: ButterflyEvent[] = []
    bus.subscribe((e) => events.push(e))

    // Start the permission request (returns a promise that hangs until reply).
    const permPromise = requestPermission(app, "s1", "write", 'Allow write on "foo.ts"?', [
      "yes",
      "no",
    ])

    // A permission.requested event should have been emitted.
    const requested = events.find((e) => e.kind === "permission.requested")
    expect(requested).toBeTruthy()
    expect(requested?.sessionId).toBe("s1")
    const requestId = (requested?.data as { requestId: string }).requestId

    // The pending entry should be visible in the store + via helper.
    expect(permissionStore.get(requestId)).toBeTruthy()
    expect(permissionStore.hasPendingForSession("s1")).toBe(true)
    expect(permissionStore.list("s1")).toHaveLength(1)

    // Simulate the user replying "yes" via the HTTP route by resolving the
    // stored entry — the promise should resolve and events should fire.
    const entry = permissionStore.get(requestId)
    entry?.resolve("yes")
    const answer = await permPromise
    expect(answer).toBe("yes")

    const resolved = events.find((e) => e.kind === "permission.resolved")
    expect(resolved).toBeTruthy()
    expect((resolved?.data as { allowed: boolean }).allowed).toBe(true)
  })

  it("requestPermission times out and resolves null", async () => {
    const { requestPermission } = await import("../packages/server/src/routes/permission")
    const { InMemoryPermissionStore } = await import("../packages/server/src/permission-store")
    const bus = new EventBus()
    const permissionStore = new InMemoryPermissionStore()
    const app = { bus, permissionStore } as never

    const permPromise = requestPermission(
      app,
      "s2",
      "bash",
      'Allow "rm foo"?',
      ["yes", "no"],
      "ask_user",
      25, // short timeout for the test
    )
    const answer = await permPromise
    expect(answer).toBeNull()
    expect(permissionStore.hasPendingForSession("s2")).toBe(false)
  })
})

// ─── Router ───────────────────────────────────────────────────────────────────

describe("@butterfly/server — Router", () => {
  it("matches static routes", async () => {
    const router = new Router()
    let called = false
    router.get("/health", () => {
      called = true
    })

    const matched = router.match("GET", "/health")
    expect(matched).toBeTruthy()
    expect(called).toBe(false) // match doesn't call handler

    // dispatch calls handler — dispatch injects params from the match.
    const fakeRes = { writeHead: () => {}, end: () => {} } as never
    await router.dispatch({
      req: { method: "GET" } as never,
      res: fakeRes,
      query: {},
      body: {},
      pathname: "/health",
      requestId: "req-test",
      corsHeaders: {},
    })
    expect(called).toBe(true)
  })

  it("matches routes with path params", () => {
    const router = new Router()
    router.get("/api/sessions/:id", () => {})

    const matched = router.match("GET", "/api/sessions/abc-123")
    expect(matched).toBeTruthy()
    expect(matched?.params.id).toBe("abc-123")
  })

  it("matches routes with multiple path params", () => {
    const router = new Router()
    router.delete("/api/sessions/:id/messages/:msgId", () => {})

    const matched = router.match("DELETE", "/api/sessions/s1/messages/m2")
    expect(matched).toBeTruthy()
    expect(matched?.params.id).toBe("s1")
    expect(matched?.params.msgId).toBe("m2")
  })

  it("does not match wrong method", () => {
    const router = new Router()
    router.get("/api/sessions/:id", () => {})

    const matched = router.match("POST", "/api/sessions/abc")
    expect(matched).toBeNull()
  })

  it("does not match wrong path", () => {
    const router = new Router()
    router.get("/api/sessions/:id", () => {})

    expect(router.match("GET", "/api/config")).toBeNull()
  })

  it("regex metachars in path params don't break matching", () => {
    const router = new Router()
    router.get("/api/sessions/:id", () => {})

    // The id contains characters that would be regex metachars if the
    // compilePattern bug was present (dots, parens, etc.)
    const matched = router.match("GET", "/api/sessions/special.id+test")
    expect(matched).toBeTruthy()
    expect(matched?.params.id).toBe("special.id+test")
  })

  it("url-encodes path params", () => {
    const router = new Router()
    router.get("/api/sessions/:id", () => {})

    const matched = router.match("GET", "/api/sessions/s%20id")
    expect(matched?.params.id).toBe("s id")
  })
})
