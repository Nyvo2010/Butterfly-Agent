/**
 * Tests for the session-history features: unified diff generation, export /
 * import / search, message edit + retry, and run-state recovery.
 */

import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { EventBus } from "../packages/server/src/bus"
import { renderUnifiedDiff, unifiedDiffForFile } from "../packages/server/src/diff"
import { RunStateManager } from "../packages/server/src/run-state"
import { SessionManager } from "../packages/server/src/session-manager"
import { InMemorySessionStore } from "../packages/session/src/store"
import { createSession } from "../packages/session/src/types"

// ─── Unified diff generator ──────────────────────────────────────────────────

describe("unified diff generator", () => {
  it("returns empty for identical content", () => {
    expect(renderUnifiedDiff("a.ts", "same\n", "same\n")).toBe("")
  })

  it("produces a valid unified diff with +/- markers and hunk header", () => {
    const before = "line1\nline2\nline3\n"
    const after = "line1\nline2-changed\nline3\n"
    const diff = renderUnifiedDiff("a.ts", before, after)
    expect(diff).toContain("--- a/a.ts")
    expect(diff).toContain("+++ b/a.ts")
    expect(diff).toContain("@@ -1,3 +1,3 @@")
    expect(diff).toContain("-line2")
    expect(diff).toContain("+line2-changed")
  })

  it("handles additions and deletions", () => {
    const diff = renderUnifiedDiff("x.ts", "a\nb\n", "a\nb\nc\n")
    expect(diff).toContain("+c")
    const diff2 = renderUnifiedDiff("x.ts", "a\nb\n", "a\n")
    expect(diff2).toContain("-b")
  })

  it("unifiedDiffForFile handles undefined before/after", () => {
    expect(unifiedDiffForFile("new.ts", undefined, "hello\n")).toContain("+hello")
    expect(unifiedDiffForFile("del.ts", "bye\n", undefined)).toContain("-bye")
    expect(unifiedDiffForFile("both.ts", undefined, undefined)).toBe("")
  })
})

// ─── Session export / import / search / edit / retry ─────────────────────────

describe("SessionManager — export / import / search / edit / retry", () => {
  function makeManager() {
    const store = new InMemorySessionStore()
    const bus = new EventBus()
    return { store, bus, manager: new SessionManager(store, bus) }
  }

  it("export returns a versioned envelope with the full session", async () => {
    const { manager } = makeManager()
    const session = await manager.create({ title: "Test session" })
    const exported = await manager.export(session.id)
    expect(exported).toBeTruthy()
    expect(exported?.schemaVersion).toBe(1)
    expect(exported?.sessionId).toBe(session.id)
    expect(exported?.session.id).toBe(session.id)
    expect(exported?.exportedAt).toBeTruthy()
  })

  it("export returns null for a missing session", async () => {
    const { manager } = makeManager()
    expect(await manager.export("nope")).toBeNull()
  })

  it("import creates a NEW session and preserves messages", async () => {
    const { manager, bus } = makeManager()
    const events: unknown[] = []
    bus.subscribe((e) => events.push(e))

    const original = createSession("orig", "build")
    original.messages = [
      { id: "m1", role: "user", content: "hello", timestamp: new Date().toISOString() },
    ]
    const imported = await manager.import({ session: original })
    expect(imported).toBeTruthy()
    expect(imported?.id).not.toBe("orig")
    expect(imported?.messages).toHaveLength(1)
    expect(imported?.messages[0].content).toBe("hello")
    expect(events.some((e) => (e as { kind: string }).kind === "session.imported")).toBe(true)
  })

  it("import rejects invalid payloads", async () => {
    const { manager } = makeManager()
    expect(await manager.import(null)).toBeNull()
    expect(await manager.import({ session: { nope: true } })).toBeNull()
    expect(await manager.import({ session: { id: "x" } })).toBeNull()
  })

  it("search matches by title and message content with snippets", async () => {
    const { manager } = makeManager()
    const s = await manager.create({ title: "Fix the auth bug" })
    const loaded = await manager.load(s.id)
    if (loaded) {
      loaded.messages = [
        {
          id: "m1",
          role: "user",
          content: "please refactor the database layer",
          timestamp: new Date().toISOString(),
        },
      ]
      await manager.save(loaded)
    }

    const byTitle = await manager.search("auth bug")
    expect(byTitle).toHaveLength(1)
    expect(byTitle[0].id).toBe(s.id)

    const byContent = await manager.search("database layer")
    expect(byContent).toHaveLength(1)
    expect(byContent[0].matches[0].content).toContain("database layer")
  })

  it("editMessage updates content and preserves id/role", async () => {
    const { manager } = makeManager()
    const s = await manager.create()
    const loaded = await manager.load(s.id)
    if (loaded) {
      loaded.messages = [
        { id: "m1", role: "user", content: "old", timestamp: new Date().toISOString() },
      ]
      await manager.save(loaded)
    }
    const updated = await manager.editMessage(s.id, "m1", "new content")
    expect(updated?.messages[0].content).toBe("new content")
    expect(updated?.messages[0].id).toBe("m1")
    expect(updated?.messages[0].role).toBe("user")
  })

  it("editMessage returns null for missing session or message", async () => {
    const { manager } = makeManager()
    const s = await manager.create()
    expect(await manager.editMessage("nope", "m1", "x")).toBeNull()
    expect(await manager.editMessage(s.id, "missing", "x")).toBeNull()
  })

  it("retry truncates to the last user message and returns the query", async () => {
    const { manager } = makeManager()
    const s = await manager.create()
    const loaded = await manager.load(s.id)
    if (loaded) {
      loaded.messages = [
        { id: "m1", role: "user", content: "first", timestamp: new Date().toISOString() },
        { id: "m2", role: "assistant", content: "answer one", timestamp: new Date().toISOString() },
        { id: "m3", role: "user", content: "second", timestamp: new Date().toISOString() },
        { id: "m4", role: "assistant", content: "answer two", timestamp: new Date().toISOString() },
      ]
      await manager.save(loaded)
    }

    const prep = await manager.retry(s.id)
    expect(prep?.query).toBe("second")
    const after = await manager.load(s.id)
    expect(after?.messages).toHaveLength(3)
    expect(after?.messages[2].content).toBe("second")
  })

  it("retry returns null when no user message exists", async () => {
    const { manager } = makeManager()
    const s = await manager.create()
    expect(await manager.retry(s.id)).toBeNull()
  })
})

// ─── Run-state recovery ──────────────────────────────────────────────────────

describe("RunStateManager — recovery from persisted markers", () => {
  it("recoverFromStore clears stale markers and emits run.recovered", async () => {
    const bus = new EventBus()
    const runState = new RunStateManager(bus)
    const store = new InMemorySessionStore()

    const events: unknown[] = []
    bus.subscribe((e) => events.push(e))

    // A session that was left with an activeRun marker (e.g. server crashed).
    const interrupted = createSession("s-crashed", "build")
    interrupted.activeRun = {
      startedAt: new Date().toISOString(),
      query: "fix things",
      model: "anthropic/claude-sonnet-4-5",
      tier: "standard",
    }
    await store.save(interrupted)

    // A normal session with no marker.
    const clean = createSession("s-clean", "build")
    await store.save(clean)

    const recovered = await runState.recoverFromStore(store)
    expect(recovered).toBe(1)
    expect(events.some((e) => (e as { kind: string }).kind === "run.recovered")).toBe(true)

    const after = await store.load("s-crashed")
    expect(after?.activeRun).toBeUndefined()
    // The clean session is untouched.
    expect((await store.load("s-clean"))?.activeRun).toBeUndefined()
  })

  it("recoverFromStore skips sessions that are actively running", async () => {
    const bus = new EventBus()
    const runState = new RunStateManager(bus)
    const store = new InMemorySessionStore()

    const running = createSession("s-running", "build")
    running.activeRun = { startedAt: new Date().toISOString() }
    await store.save(running)

    runState.start("s-running")
    const recovered = await runState.recoverFromStore(store)
    expect(recovered).toBe(0)
    // Marker is kept because the run is genuinely active in this process.
    expect((await store.load("s-running"))?.activeRun).toBeTruthy()
  })
})

// ─── Code indexer ────────────────────────────────────────────────────────────

describe("CodeIndexer", () => {
  it("indexes identifiers and answers searches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bf-index-"))
    await writeFile(
      join(dir, "a.ts"),
      "export function greetUser() {}\nexport class AuthService {}\n",
    )
    await writeFile(join(dir, "b.py"), "def parse_config():\n    pass\n")

    const { CodeIndexer } = await import("../packages/server/src/indexer")
    const indexer = new CodeIndexer(dir)
    const stats = await indexer.build()
    expect(stats.files).toBe(2)
    expect(stats.symbols).toBeGreaterThanOrEqual(3)

    const hits = indexer.search("AuthService")
    expect(hits.some((h) => h.name === "AuthService")).toBe(true)

    const prefix = indexer.search("greet")
    expect(prefix.some((h) => h.name === "greetUser")).toBe(true)

    const py = indexer.search("parse")
    expect(py.some((h) => h.name === "parse_config")).toBe(true)
  })

  it("returns empty results before build and for unknown queries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bf-index2-"))
    const { CodeIndexer } = await import("../packages/server/src/indexer")
    const indexer = new CodeIndexer(dir)
    expect(indexer.search("anything")).toEqual([])
    await indexer.build()
    expect(indexer.search("zzz-does-not-exist")).toEqual([])
  })
})
