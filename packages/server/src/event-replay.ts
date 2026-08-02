/**
 * In-memory event replay buffer for SSE Last-Event-ID resume.
 *
 * Stores a bounded ring of recent events globally and per-session so reconnecting
 * clients can catch up without polling session APIs.
 */

import type { ButterflyEvent } from "./bus"

const DEFAULT_GLOBAL_CAPACITY = 500
const DEFAULT_SESSION_CAPACITY = 200

export interface EventReplayOptions {
  globalCapacity?: number
  sessionCapacity?: number
}

/** Parse `evt-123` → 123. Returns 0 for invalid ids. */
export function parseEventSeq(id: string): number {
  const m = /^evt-(\d+)$/.exec(id)
  return m ? Number(m[1]) : 0
}

function pushRing<T>(buf: T[], item: T, capacity: number): void {
  buf.push(item)
  if (buf.length > capacity) {
    buf.splice(0, buf.length - capacity)
  }
}

export class EventReplayBuffer {
  private readonly global: ButterflyEvent[] = []
  private readonly bySession = new Map<string, ButterflyEvent[]>()
  private readonly globalCapacity: number
  private readonly sessionCapacity: number

  constructor(opts: EventReplayOptions = {}) {
    this.globalCapacity = opts.globalCapacity ?? DEFAULT_GLOBAL_CAPACITY
    this.sessionCapacity = opts.sessionCapacity ?? DEFAULT_SESSION_CAPACITY
  }

  /** Record an event for later replay. */
  append(event: ButterflyEvent): void {
    pushRing(this.global, event, this.globalCapacity)
    if (event.sessionId) {
      const sessionBuf = this.bySession.get(event.sessionId) ?? []
      pushRing(sessionBuf, event, this.sessionCapacity)
      this.bySession.set(event.sessionId, sessionBuf)
    }
  }

  /**
   * Return events after `afterId` (exclusive). When `afterId` is missing, returns
   * the full buffered history for the scope.
   */
  replay(afterId: string | undefined, sessionId?: string): ButterflyEvent[] {
    const buf = sessionId ? (this.bySession.get(sessionId) ?? []) : this.global
    if (!afterId) return [...buf]
    const afterSeq = parseEventSeq(afterId)
    return buf.filter((e) => parseEventSeq(e.id) > afterSeq)
  }

  clear(): void {
    this.global.length = 0
    this.bySession.clear()
  }
}
