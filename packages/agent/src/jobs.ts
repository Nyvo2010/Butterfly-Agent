/**
 * Background jobs system — mirrors OpenCode's background job infrastructure.
 * Runs periodic maintenance tasks: stale session cleanup and orphaned lock
 * cleanup.
 *
 * IMPORTANT: stale-session auto-delete is OPT-IN. Butterfly never deletes
 * sessions unless the operator explicitly sets `butterfly.backgroundJobs`
 * `staleSessionAgeMs` in config. Silent data loss is worse than disk bloat,
 * so the default is OFF (0 = disabled).
 *
 * Jobs run on a configurable interval (default 60s) and are automatically
 * stopped when the agent disposes.
 */

import { log } from "@butterfly/core"
import type { SessionStore } from "@butterfly/session"

export interface BackgroundJobsOptions {
  /** Working directory for context-sensitive jobs. */
  cwd: string
  /** Session store for stale session cleanup. */
  store: SessionStore
  /** Butterfly config for feature flags and tuning. */
  config: { butterfly?: { backgroundJobs?: { intervalMs?: number; staleSessionAgeMs?: number } } }
}

export interface BackgroundJobsHandle {
  /** Stop all background jobs. Idempotent. */
  stop: () => void
}

/**
 * Default stale-session cleanup age. 0 = disabled (opt-in).
 * Operators enable cleanup by setting `butterfly.backgroundJobs.staleSessionAgeMs`.
 */
const DEFAULT_STALE_SESSION_AGE_MS = 0

/** Default interval between job runs (60s). */
const DEFAULT_INTERVAL_MS = 60_000

export function startBackgroundJobs(opts: BackgroundJobsOptions): BackgroundJobsHandle {
  const intervalMs = opts.config.butterfly?.backgroundJobs?.intervalMs ?? DEFAULT_INTERVAL_MS
  const staleAgeMs =
    opts.config.butterfly?.backgroundJobs?.staleSessionAgeMs ?? DEFAULT_STALE_SESSION_AGE_MS

  // Opt-in: cleanup only runs when staleSessionAgeMs is explicitly set to a
  // positive value. 0/undefined/negative means "never delete sessions".
  const cleanupEnabled = Number.isFinite(staleAgeMs) && staleAgeMs > 0

  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  const run = async () => {
    if (stopped) return

    try {
      // ── Stale session cleanup (opt-in) ─────────────────────────────
      if (cleanupEnabled) {
        const now = Date.now()
        const staleThreshold = now - staleAgeMs

        const sessionEntries = await opts.store.list()
        if (sessionEntries && sessionEntries.length > 0) {
          let cleaned = 0
          for (const entry of sessionEntries) {
            try {
              const updatedAt = new Date(entry.updatedAt).getTime()
              if (Number.isNaN(updatedAt)) continue
              if (updatedAt < staleThreshold) {
                await opts.store.delete(entry.id)
                cleaned++
              }
            } catch (err) {
              log(
                "warn",
                `[background] failed to clean session ${entry.id}: ${(err as Error).message}`,
              )
            }
          }
          if (cleaned > 0) {
            log("info", `[background] cleaned ${cleaned} stale sessions`)
          }
        }
      }
    } catch (err) {
      log("warn", `[background] job error: ${(err as Error).message}`)
    }
  }

  // Run immediately on start, then on interval.
  run().catch((err) => {
    log("warn", `[background] initial run error: ${(err as Error).message}`)
  })
  timer = setInterval(() => {
    run().catch((err) => {
      log("warn", `[background] interval run error: ${(err as Error).message}`)
    })
  }, intervalMs)

  // Don't prevent the Node.js process from exiting just because
  // background jobs are scheduled. The caller controls the process lifecycle.
  if (timer && typeof timer === "object" && "unref" in timer) {
    timer.unref()
  }

  return {
    stop: () => {
      stopped = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
