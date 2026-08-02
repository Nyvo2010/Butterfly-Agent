/**
 * Cursor pagination helpers — OpenCode-style opaque base64url cursors.
 *
 * Cursors encode the last item's sort key (id + timestamp) so clients can page
 * forward/backward without offset drift when new items arrive. Opaque to
 * clients: they just pass `cursor` back verbatim.
 */

export interface CursorValue {
  id: string
  /** ISO timestamp or epoch ms used as the sort key. */
  time: string
}

/** Encode a cursor value into an opaque base64url string. */
export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

/** Decode a cursor string. Returns null for malformed/empty input. */
export function decodeCursor(raw: string | undefined): CursorValue | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<CursorValue>
    if (typeof parsed.id !== "string" || typeof parsed.time !== "string") return null
    return { id: parsed.id, time: parsed.time }
  } catch {
    return null
  }
}

/** Default page size when the client doesn't supply one. */
export const DEFAULT_PAGE_SIZE = 50

/** Parse a `limit` query param into a sane page size. */
export function parseLimit(raw: string | undefined, max = 200): number {
  if (!raw) return DEFAULT_PAGE_SIZE
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(n, max)
}

/**
 * True when `value` sorts after `cursor` in ASCENDING order (oldest-first lists).
 * Used for message lists which are naturally chronological.
 */
export function isAfterCursor(value: { id: string; time: string }, cursor: CursorValue): boolean {
  if (value.time === cursor.time) return value.id > cursor.id
  return value.time > cursor.time
}

/**
 * True when `value` sorts after `cursor` in DESCENDING order (newest-first lists).
 * Used for session lists, which are sorted by updatedAt desc.
 */
export function isAfterCursorDesc(
  value: { id: string; time: string },
  cursor: CursorValue,
): boolean {
  if (value.time === cursor.time) return value.id < cursor.id
  return value.time < cursor.time
}
