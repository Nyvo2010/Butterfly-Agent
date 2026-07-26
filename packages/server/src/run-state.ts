/**
 * Run State Manager — tracks the lifecycle of agent runs per session.
 *
 * Inspired by OpenCode's session/run-state.ts: the store holds persisted state,
 * but the *live* run status (is the loop running? busy? cancelable?) is runtime
 * state that lives in memory and never touches disk.
 *
 * Responsibilities:
 *   - Track which sessions currently have an active agent loop running
 *   - Provide AbortControllers so routes can cancel a running loop
 *   - Enforce single-run-per-session concurrency (a new prompt aborts the prior)
 *   - Emit run.* events on the bus as state transitions occur
 *
 * This is what the client uses to show "running..." indicators and to send
 * abort commands. The actual agent loop execution lives in @butterfly/agent;
 * this manager only coordinates the bookkeeping.
 */

import { log } from "@butterfly/core"
import type { EventBus } from "./bus"

export type RunStatus = "idle" | "running"

interface RunEntry {
  sessionId: string
  status: RunStatus
  abort: AbortController
  startedAt: string
  /** Promise that resolves when the run completes (for awaiting in routes). */
  done: Promise<void>
}

export class RunStateManager {
  private readonly runs = new Map<string, RunEntry>()
  /** Resolvers keyed by sessionId, called when a run finishes. */
  private readonly resolvers = new Map<string, () => void>()

  constructor(private readonly bus: EventBus) {}

  /**
   * Begin tracking a run for a session. If a run is already active, it is
   * aborted first (single-run-per-session concurrency).
   *
   * Returns the AbortController the caller should pass to the agent loop.
   * The `done` promise resolves when the run completes or is aborted.
   */
  start(sessionId: string): { abort: AbortController; done: Promise<void> } {
    // Abort any existing run for this session.
    this.abort(sessionId)

    const abort = new AbortController()
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    this.resolvers.set(sessionId, resolveDone)

    const entry: RunEntry = {
      sessionId,
      status: "running",
      abort,
      startedAt: new Date().toISOString(),
      done,
    }
    this.runs.set(sessionId, entry)

    this.bus.emit({ kind: "run.started", sessionId })
    log("info", "run_state.start", { sessionId })
    return { abort, done }
  }

  /**
   * Mark a run as completed and remove it from tracking.
   *
   * If `expectedAbort` is provided, the completion is only applied when the
   * active entry's AbortController is the same one. This prevents a stale run
   * from completing a newer run that took over the same sessionId (concurrency
   * safety when a new prompt aborts an in-flight one).
   */
  complete(
    sessionId: string,
    info: { iterations: number; stopReason: string; model: string; tier: string },
    expectedAbort?: AbortController,
  ): void {
    const entry = this.runs.get(sessionId)
    if (!entry) return
    if (expectedAbort && entry.abort !== expectedAbort) return
    this.runs.delete(sessionId)
    this.bus.emit({ kind: "run.completed", sessionId, data: info })
    log("info", "run_state.complete", { sessionId, ...info })
    this.resolve(sessionId)
  }

  /**
   * Mark a run as errored and remove it from tracking.
   *
   * Same concurrency guard as `complete()` via `expectedAbort`.
   */
  error(sessionId: string, message: string, expectedAbort?: AbortController): void {
    const entry = this.runs.get(sessionId)
    if (!entry) return
    if (expectedAbort && entry.abort !== expectedAbort) return
    this.runs.delete(sessionId)
    this.bus.emit({ kind: "run.error", sessionId, data: { message } })
    log("error", "run_state.error", { sessionId, message })
    this.resolve(sessionId)
  }

  /**
   * Abort a running session's loop. No-op if no run is active.
   *
   * If `expectedAbort` is provided, the abort is only applied when the active
   * entry's AbortController is the same one. This prevents a stale run from
   * aborting a newer run that took over the same sessionId (concurrency safety
   * when a new prompt aborts an in-flight one) — and prevents duplicate
   * `run.aborted` events.
   */
  abort(sessionId: string, expectedAbort?: AbortController): boolean {
    const entry = this.runs.get(sessionId)
    if (!entry) return false
    if (expectedAbort && entry.abort !== expectedAbort) return false
    if (!entry.abort.signal.aborted) {
      entry.abort.abort()
    }
    this.runs.delete(sessionId)
    this.bus.emit({ kind: "run.aborted", sessionId })
    log("info", "run_state.abort", { sessionId })
    this.resolve(sessionId)
    return true
  }

  /** Get the current run status for a session (idle if not running). */
  status(sessionId: string): RunStatus {
    return this.runs.get(sessionId)?.status ?? "idle"
  }

  /** Whether a session currently has an active run. */
  isActive(sessionId: string): boolean {
    return this.runs.has(sessionId)
  }

  /** Get the AbortController for a session's run (if active). */
  getAbort(sessionId: string): AbortController | undefined {
    return this.runs.get(sessionId)?.abort
  }

  /** Wait for a session's run to complete. Resolves immediately if idle. */
  await(sessionId: string): Promise<void> {
    const entry = this.runs.get(sessionId)
    return entry ? entry.done : Promise.resolve()
  }

  /** Abort all active runs (used on shutdown). */
  abortAll(): void {
    for (const sessionId of this.runs.keys()) {
      this.abort(sessionId)
    }
  }

  /** Number of currently active runs. */
  count(): number {
    return this.runs.size
  }

  /** List active run session ids. */
  activeSessions(): string[] {
    return Array.from(this.runs.keys())
  }

  private resolve(sessionId: string): void {
    const r = this.resolvers.get(sessionId)
    if (r) {
      this.resolvers.delete(sessionId)
      r()
    }
  }
}
