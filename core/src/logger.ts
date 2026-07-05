// Structured logging placeholder.
// Event-based tracing, not ad-hoc console.log.

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEvent {
  level: LogLevel
  message: string
  timestamp: string
  context?: Record<string, unknown>
}

export function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const event: LogEvent = {
    level,
    message,
    timestamp: new Date().toISOString(),
    context,
  }
  // TODO: route to structured JSON output / tracing backend
  if (level === "error") {
    console.error(JSON.stringify(event))
  } else {
    console.log(JSON.stringify(event))
  }
}
