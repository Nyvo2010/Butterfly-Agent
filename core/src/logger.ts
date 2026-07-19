// Structured logging placeholder.
// Event-based tracing, not ad-hoc console.log.

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEvent {
  level: LogLevel
  message: string
  timestamp: string
  context?: Record<string, unknown>
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let configuredLevel: number | null = null

function getThreshold(): number {
  if (configuredLevel === null) {
    const env = process.env.AGENT_LOG_LEVEL ?? "info"
    configuredLevel = LEVEL_ORDER[env as LogLevel] ?? 1
  }
  return configuredLevel
}

export function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < getThreshold()) return

  const event: LogEvent = {
    level,
    message,
    timestamp: new Date().toISOString(),
    context,
  }
  if (level === "error") {
    console.error(JSON.stringify(event))
  } else {
    console.log(JSON.stringify(event))
  }
}
