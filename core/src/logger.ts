// Structured logging — emits JSON-formatted log events to stdout/stderr.
// All subsystems should use `log()` instead of ad-hoc console.log.

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEvent {
  level: LogLevel
  message: string
  timestamp: string
  context?: Record<string, unknown>
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const MAX_LOG_DEPTH = 5
const MAX_LOG_STR_LEN = 1000

function truncateContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet()
  function walk(value: unknown, depth: number): unknown {
    if (depth > MAX_LOG_DEPTH) return "[Truncated]"
    if (typeof value === "string") {
      return value.length > MAX_LOG_STR_LEN ? `${value.slice(0, MAX_LOG_STR_LEN)}...` : value
    }
    if (value === null || value === undefined) return value
    if (typeof value !== "object") return value
    if (value instanceof Error) {
      return { message: value.message, stack: value.stack, name: value.name }
    }
    if (seen.has(value as object)) return "[Circular]"
    seen.add(value as object)
    if (Array.isArray(value)) {
      return value.map((v) => walk(v, depth + 1))
    }
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = walk(v, depth + 1)
    }
    return obj
  }
  return walk(ctx, 0) as Record<string, unknown>
}

/**
 * Configure the log threshold. Call this at startup with the resolved config value.
 * If never called, defaults to "info".
 */
let configuredLevel: number = LEVEL_ORDER.info

export function setLogLevel(level: LogLevel): void {
  configuredLevel = LEVEL_ORDER[level] ?? LEVEL_ORDER.info
}

export function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < configuredLevel) return

  const event: LogEvent = {
    level,
    message,
    timestamp: new Date().toISOString(),
    context: context ? truncateContext(context) : undefined,
  }
  let serialized: string
  try {
    serialized = JSON.stringify(event, (_, value) => {
      if (value instanceof Error) {
        return { message: value.message, stack: value.stack, name: value.name }
      }
      return value
    })
  } catch {
    serialized = JSON.stringify({ level, message, timestamp: event.timestamp })
  }
  if (level === "error") {
    console.error(serialized)
  } else if (level === "warn") {
    console.warn(serialized)
  } else {
    console.log(serialized)
  }
}
