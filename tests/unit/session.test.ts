import type { SessionState } from "@butterfly/session"
import { createSession, InMemorySessionStore } from "@butterfly/session"
import { describe, expect, it } from "vitest"

describe("session / createSession", () => {
  it("creates a session with given id and mode", () => {
    const s = createSession("test-1", "build")
    expect(s.id).toBe("test-1")
    expect(s.mode).toBe("build")
    expect(s.tier).toBe("standard")
    expect(s.messages).toEqual([])
    expect(s.toolCalls).toEqual([])
    expect(s.fileChanges).toEqual([])
    expect(s.startedAt).toBeTruthy()
    expect(s.updatedAt).toBeTruthy()
  })

  it("accepts custom tier", () => {
    const s = createSession("test-2", "plan", "trivial")
    expect(s.tier).toBe("trivial")
  })

  it("creates orchestrator mode sessions", () => {
    const s = createSession("test-3", "orchestrator")
    expect(s.mode).toBe("orchestrator")
  })

  it("timestamps are valid ISO strings", () => {
    const s = createSession("a", "build")
    expect(s.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(s.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe("session / InMemorySessionStore", () => {
  it("saves and loads a session", async () => {
    const store = new InMemorySessionStore()
    const s = createSession("s1", "build")
    await store.save(s)
    const loaded = await store.load("s1")
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe("s1")
    expect(loaded!.mode).toBe("build")
  })

  it("returns null for non-existent session", async () => {
    const store = new InMemorySessionStore()
    const loaded = await store.load("nonexistent")
    expect(loaded).toBeNull()
  })

  it("updates updatedAt on save", async () => {
    const store = new InMemorySessionStore()
    const s = createSession("s1", "build")
    const original = s.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await store.save(s)
    const loaded = await store.load("s1")
    expect(loaded!.updatedAt).not.toBe(original)
  })

  it("lists sessions sorted by update time descending (most recent last-saved first)", async () => {
    const store = new InMemorySessionStore()
    const s1 = createSession("old", "build")
    await store.save(s1)
    await new Promise((r) => setTimeout(r, 5))
    const s2 = createSession("new", "plan")
    await store.save(s2)
    const list = await store.list()
    // "new" saved last, so its updatedAt is later
    expect(list[0].id).toBe("new")
    expect(list[1].id).toBe("old")
  })

  it("save overwrites existing session", async () => {
    const store = new InMemorySessionStore()
    const s = createSession("s1", "build")
    await store.save(s)
    s.messages.push({
      id: "m1",
      role: "user",
      content: "hi",
      timestamp: new Date().toISOString(),
    })
    await store.save(s)
    const loaded = await store.load("s1")
    expect(loaded!.messages).toHaveLength(1)
  })

  it("throws on save without id", async () => {
    const store = new InMemorySessionStore()
    const bad = { id: "" } as unknown as SessionState
    await expect(store.save(bad)).rejects.toThrow("id is required")
  })

  it("list returns empty array when no sessions", async () => {
    const store = new InMemorySessionStore()
    const list = await store.list()
    expect(list).toEqual([])
  })
})
