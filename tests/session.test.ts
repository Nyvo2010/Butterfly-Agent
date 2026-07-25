import { describe, expect, it } from "vitest"
import { InMemorySessionStore } from "../packages/session/src/store"
import { createSession } from "../packages/session/src/types"

describe("@butterfly/session — types", () => {
  it("createSession initializes a fresh session", () => {
    const s = createSession("test-1", "build")
    expect(s.id).toBe("test-1")
    expect(s.mode).toBe("build")
    expect(s.tier).toBe("standard")
    expect(s.messages).toEqual([])
    expect(s.toolCalls).toEqual([])
    expect(s.fileChanges).toEqual([])
    expect(s.readFiles).toEqual([])
    expect(s.startedAt).toBeTruthy()
    expect(s.updatedAt).toBeTruthy()
  })

  it("createSession accepts custom tier", () => {
    const s = createSession("t2", "plan", "complex")
    expect(s.tier).toBe("complex")
    expect(s.mode).toBe("plan")
  })
})

describe("@butterfly/session — InMemorySessionStore", () => {
  it("save and load round-trip", async () => {
    const store = new InMemorySessionStore()
    const s = createSession("round-trip", "build")
    await store.save(s)
    const loaded = await store.load("round-trip")
    expect(loaded).toBeTruthy()
    expect(loaded?.id).toBe("round-trip")
  })

  it("load returns null for missing session", async () => {
    const store = new InMemorySessionStore()
    const loaded = await store.load("missing")
    expect(loaded).toBeNull()
  })

  it("list returns sessions sorted by updatedAt desc", async () => {
    const store = new InMemorySessionStore()
    await store.save(createSession("a", "build"))
    await new Promise((r) => setTimeout(r, 5))
    await store.save(createSession("b", "plan"))
    const list = await store.list()
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe("b")
    expect(list[1].id).toBe("a")
  })

  it("delete removes a session", async () => {
    const store = new InMemorySessionStore()
    await store.save(createSession("del", "build"))
    await store.delete("del")
    expect(await store.load("del")).toBeNull()
  })
})
