/**
 * Cursor pagination helper tests — encode/decode and ordering predicates.
 */
import { describe, expect, it } from "vitest"
import {
  decodeCursor,
  encodeCursor,
  isAfterCursor,
  isAfterCursorDesc,
  parseLimit,
} from "../packages/server/src/cursor"

describe("@butterfly/server — cursor", () => {
  it("round-trips encode/decode", () => {
    const value = { id: "s-1", time: "2026-08-02T10:00:00.000Z" }
    expect(decodeCursor(encodeCursor(value))).toEqual(value)
  })

  it("decodes null for empty or malformed cursors", () => {
    expect(decodeCursor(undefined)).toBeNull()
    expect(decodeCursor("")).toBeNull()
    expect(decodeCursor("not-base64-json")).toBeNull()
    expect(decodeCursor("aGVsbG8=")).toBeNull() // "hello" — not a cursor shape
  })

  it("isAfterCursor compares ascending by time then id", () => {
    const c = { id: "m-2", time: "2026-08-02T10:00:00.000Z" }
    expect(isAfterCursor({ id: "m-3", time: "2026-08-02T10:00:01.000Z" }, c)).toBe(true)
    expect(isAfterCursor({ id: "m-1", time: "2026-08-02T09:59:00.000Z" }, c)).toBe(false)
    // Same time → tiebreak by id.
    expect(isAfterCursor({ id: "m-3", time: c.time }, c)).toBe(true)
    expect(isAfterCursor({ id: "m-1", time: c.time }, c)).toBe(false)
  })

  it("isAfterCursorDesc compares descending (newest-first lists)", () => {
    const c = { id: "s-2", time: "2026-08-02T10:00:00.000Z" }
    // In a newest-first list, items AFTER the cursor are older (smaller time).
    expect(isAfterCursorDesc({ id: "s-1", time: "2026-08-02T09:00:00.000Z" }, c)).toBe(true)
    expect(isAfterCursorDesc({ id: "s-3", time: "2026-08-02T11:00:00.000Z" }, c)).toBe(false)
  })

  it("parseLimit clamps to sane bounds", () => {
    expect(parseLimit(undefined)).toBe(50)
    expect(parseLimit("10")).toBe(10)
    expect(parseLimit("0")).toBe(50)
    expect(parseLimit("abc")).toBe(50)
    expect(parseLimit("9999")).toBe(200)
  })
})
