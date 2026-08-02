/**
 * Loop Detector — catches the #1 real-world agent failure mode: the model
 * repeating the same tool call (or wandering across endless variants) without
 * making progress.
 *
 * Ported from Atomic Agent's `src/agent/loop-detector.ts` and adapted to
 * Butterfly's tool-call shape. Three detectors:
 *
 *   1. `generic_repeat`  — same (tool, args) called repeatedly → warn
 *   2. `no_progress`     — same (tool, args) repeated *and failing* → critical
 *                          (the loop vetoes the call and injects a notice)
 *   3. `wandering`       — wandering-prone tools called with ever-changing
 *                          args (endless distinct searches/reads) → warn, then
 *                          critical when the spread is large
 *
 * The tracker is a sliding-window history ring. `check()` is called BEFORE a
 * tool executes (to veto a would-be repeat); `record()` is called AFTER with
 * the outcome. Notices are de-duplicated per `warningKey` bucket so the loop
 * doesn't re-inject the same instruction every step.
 */

import { createHash } from "node:crypto"

export type LoopCheckLevel = "ok" | "warn" | "critical"

export type LoopDetectorKind = "generic_repeat" | "no_progress" | "wandering"

export interface LoopCheckVerdict {
  level: LoopCheckLevel
  detector: LoopDetectorKind
  /** Repeat count (warn) or no-progress streak length (critical). */
  count: number
  /** Stable key for notice de-duplication. */
  warningKey: string
  tool: string
}

export interface ToolLoopTrackerOptions {
  /** Args-only repeat count that fires a `warn`. Default 3. */
  warningThreshold?: number
  /** No-progress streak (args+result) that fires a `critical` veto. Default 5. */
  criticalThreshold?: number
  /** Consecutive vetoes of one signature that trip the breaker. Default 3. */
  breakerVetoStreak?: number
  /** Sliding window size for the history ring. Default 30. */
  historySize?: number
  /** Distinct-args spread on wandering-prone tools that fires a `warn`. Default 6. */
  wanderingThreshold?: number
  /** Distinct-args spread that escalates to a forced graceful reply. Default 12. */
  wanderingEscalation?: number
}

const DEFAULTS: Required<ToolLoopTrackerOptions> = {
  warningThreshold: 3,
  criticalThreshold: 5,
  breakerVetoStreak: 3,
  historySize: 30,
  wanderingThreshold: 6,
  wanderingEscalation: 12,
}

interface HistoryEntry {
  tool: string
  hash: string
  ok: boolean
  at: number
}

/**
 * Tools whose repeated invocation with ever-changing arguments is a
 * "wandering" loop (probing endless distinct files/queries/pages without
 * converging). Bulk reads over distinct paths are the canonical example.
 */
const WANDER_TOOLS = new Set(["search", "grep", "glob", "webfetch"])

export function argsHash(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input ?? {}))
    .digest("hex")
    .slice(0, 16)
}

export class ToolLoopTracker {
  private readonly opts: Required<ToolLoopTrackerOptions>
  private readonly history: HistoryEntry[] = []
  private readonly noticeEmitted = new Map<string, number>()
  private readonly vetoStreak = new Map<string, number>()

  constructor(opts: ToolLoopTrackerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts }
  }

  /**
   * Inspect a pending tool call BEFORE execution. Returns a verdict:
   *   - `ok`         — proceed
   *   - `warn`       — proceed, but inject the associated notice
   *   - `critical`   — veto the call (do not execute); inject the notice
   */
  check(tool: string, input: unknown): LoopCheckVerdict {
    const hash = argsHash(input)
    const history = this.history

    // ── 2. No-progress streak (same args, previous calls failed) ──────────
    let streak = 0
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i]
      if (h.tool !== tool || h.hash !== hash) break
      if (h.ok) break // a success resets the streak
      streak++
    }
    // Including THIS call, the streak would be streak + 1.
    if (streak + 1 >= this.opts.criticalThreshold) {
      return {
        level: "critical",
        detector: "no_progress",
        count: streak + 1,
        warningKey: `no_progress:${tool}:${hash}`,
        tool,
      }
    }

    // ── 1. Generic repeat (same args called repeatedly, regardless of result)
    let repeats = 0
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i]
      if (h.tool === tool && h.hash === hash) repeats++
      else if (h.tool === tool) break // another arg signature interrupts the run
    }
    if (repeats + 1 >= this.opts.warningThreshold) {
      return {
        level: "warn",
        detector: "generic_repeat",
        count: repeats + 1,
        warningKey: `generic_repeat:${tool}:${hash}`,
        tool,
      }
    }

    // ── 3. Wandering (distinct args spread on wandering-prone tools) ──────
    if (WANDER_TOOLS.has(tool)) {
      const distinct = new Set<string>([hash])
      for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i]
        if (h.tool !== tool) break
        distinct.add(h.hash)
      }
      if (distinct.size >= this.opts.wanderingEscalation) {
        return {
          level: "critical",
          detector: "wandering",
          count: distinct.size,
          warningKey: `wandering:${tool}`,
          tool,
        }
      }
      if (distinct.size >= this.opts.wanderingThreshold) {
        return {
          level: "warn",
          detector: "wandering",
          count: distinct.size,
          warningKey: `wandering:${tool}`,
          tool,
        }
      }
    }

    return { level: "ok", detector: "generic_repeat", count: 0, warningKey: "", tool }
  }

  /** Record the outcome of an executed tool call (call AFTER execution). */
  record(tool: string, input: unknown, ok: boolean): void {
    this.history.push({ tool, hash: argsHash(input), ok, at: Date.now() })
    if (this.history.length > this.opts.historySize) {
      this.history.shift()
    }
  }

  /**
   * Register that a critical verdict vetoed a call. Returns true when the
   * breaker trips (too many consecutive vetoes on one signature) — the loop
   * should stop retrying and emit a graceful final reply.
   */
  registerVeto(verdict: LoopCheckVerdict): boolean {
    const key = verdict.warningKey
    const next = (this.vetoStreak.get(key) ?? 0) + 1
    this.vetoStreak.set(key, next)
    return next >= this.opts.breakerVetoStreak
  }

  /** Reset veto tracking for a signature (after the model adapts). */
  clearVetoes(verdict: LoopCheckVerdict): void {
    this.vetoStreak.delete(verdict.warningKey)
  }

  /**
   * Human-readable notice text for a verdict, injected into the next prompt.
   * Warn-level notices are de-duplicated per warningKey using a bucket counter
   * (at most 1 in 5 repeats); critical notices always surface — the loop needs
   * the veto message even when the notice was recently shown.
   */
  noticeFor(verdict: LoopCheckVerdict): string | null {
    if (verdict.level === "ok") return null
    if (verdict.level === "critical") {
      this.noticeEmitted.set(
        verdict.warningKey,
        (this.noticeEmitted.get(verdict.warningKey) ?? 0) + 1,
      )
    } else {
      const emitted = this.noticeEmitted.get(verdict.warningKey) ?? 0
      if (emitted > 0 && emitted % 5 !== 0) {
        this.noticeEmitted.set(verdict.warningKey, emitted + 1)
        return null
      }
      this.noticeEmitted.set(verdict.warningKey, emitted + 1)
    }

    switch (verdict.detector) {
      case "no_progress":
        return (
          `You are repeating the same failing action (${verdict.tool}, attempt ` +
          `${verdict.count}). Stop trying this approach. Re-read the file or error, ` +
          `change strategy, or explain the blocker to the user.`
        )
      case "generic_repeat":
        return (
          `You have called ${verdict.tool} with identical arguments ${verdict.count} times. ` +
          `Avoid repeating calls — inspect what changed and make forward progress.`
        )
      case "wandering":
        return (
          `You are probing many different ${verdict.tool} targets without converging ` +
          `(${verdict.count} distinct variants). Pick the most relevant target and ` +
          `commit to it, or summarize what you found and finish.`
        )
    }
  }
}
