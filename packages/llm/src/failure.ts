/**
 * LLM failure classification — the backbone of retry + escalation policy.
 *
 * Inspired by Atomic Agent's `llm/reliability/classify-failure.ts`. The agent
 * loop uses `classifyFailure` to decide:
 *   - whether a transient error (rate limit, timeout, 5xx) should be retried
 *   - which failures are fatal and should NOT trigger model escalation
 *   - how to surface structured diagnostics to operators
 *
 * Pure module — no dependencies beyond node:util. Kept dependency-free so the
 * llm package stays self-contained.
 */

/** Categories of LLM/provider failures the agent loop understands. */
export type FailureCategory =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "server_error"
  | "context_overflow"
  | "model_not_found"
  | "invalid_request"
  | "network"
  | "unknown"

export interface ClassifiedFailure {
  category: FailureCategory
  /** Whether the loop should retry this failure with backoff. */
  retryable: boolean
  /** Human-readable reason (best effort extraction). */
  message: string
  /** Optional HTTP status code when the error carried one. */
  status?: number
}

const RETRYABLE_CATEGORIES: ReadonlySet<FailureCategory> = new Set([
  "rate_limit",
  "timeout",
  "server_error",
  "network",
])

/** Pull a numeric HTTP status out of any error-shaped value. */
function extractStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown } | null
  if (!e || typeof e !== "object") return undefined
  for (const key of ["status", "statusCode"] as const) {
    const v = e[key]
    if (typeof v === "number" && Number.isInteger(v) && v >= 100 && v < 600) return v
  }
  // AI SDK errors often carry status under `statusCode` or a numeric `code`.
  if (typeof e.code === "number" && Number.isInteger(e.code) && e.code >= 100 && e.code < 600) {
    return e.code
  }
  return undefined
}

/** Best-effort message extraction from any thrown value. */
export function failureMessage(err: unknown): string {
  if (typeof err === "string") return err
  if (err instanceof Error) return err.message
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message
    if (typeof m === "string") return m
  }
  return String(err)
}

/**
 * Classify a thrown LLM failure into a category with retry + escalation hints.
 * Uses status codes when present, then falls back to message pattern matching.
 */
export function classifyFailure(err: unknown): ClassifiedFailure {
  const status = extractStatus(err)
  const message = failureMessage(err)
  const lower = message.toLowerCase()

  // ── Status-code fast path ────────────────────────────────────────────────
  if (status !== undefined) {
    if (status === 429 || status === 402) {
      return { category: "rate_limit", retryable: true, message, status }
    }
    if (status === 401 || status === 403) {
      return { category: "auth", retryable: false, message, status }
    }
    if (status === 408 || status === 504) {
      return { category: "timeout", retryable: true, message, status }
    }
    if (status === 404) {
      return {
        category: /model/i.test(lower) ? "model_not_found" : "invalid_request",
        retryable: false,
        message,
        status,
      }
    }
    if (status >= 500 && status <= 599) {
      return { category: "server_error", retryable: true, message, status }
    }
    if (status >= 400 && status <= 499) {
      return { category: "invalid_request", retryable: false, message, status }
    }
  }

  // ── Message-pattern fallback ─────────────────────────────────────────────
  if (/(rate\s*limit|too\s*many\s*requests|quota|429|402)/i.test(lower)) {
    return { category: "rate_limit", retryable: true, message }
  }
  if (/(api\s*key|unauthorized|authentication|invalid\s*credentials|401|403)/i.test(lower)) {
    return { category: "auth", retryable: false, message }
  }
  if (/(timed?\s*out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|408|504)/i.test(lower)) {
    return { category: "timeout", retryable: true, message }
  }
  if (/(model\s+not\s+found|unknown\s+model|does\s+not\s+exist|404)/i.test(lower)) {
    return { category: "model_not_found", retryable: false, message }
  }
  if (
    /(context\s*(length|window|overflow)|maximum\s*context|token\s*limit|max_tokens)/i.test(lower)
  ) {
    return { category: "context_overflow", retryable: false, message }
  }
  if (
    /(ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch\s*failed|socket|network\s*error|connection\s*reset)/i.test(
      lower,
    )
  ) {
    return { category: "network", retryable: true, message }
  }
  if (/(500|502|503|529|internal\s*server|overloaded|unavailable|bad\s*gateway)/i.test(lower)) {
    return { category: "server_error", retryable: true, message }
  }
  if (/(bad\s*request|invalid\s*request|400|422)/i.test(lower)) {
    return { category: "invalid_request", retryable: false, message }
  }

  return { category: "unknown", retryable: false, message }
}

/** Convenience: is this failure worth a retry with backoff? */
export function isRetryable(err: unknown): boolean {
  return RETRYABLE_CATEGORIES.has(classifyFailure(err).category)
}

/** Async sleep helper for backoff. Kept here so llm stays dependency-free. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
