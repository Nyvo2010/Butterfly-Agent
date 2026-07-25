// Config layer: all process.env access must go through here.
// No subsystem may read process.env directly.

import type { LogLevel } from "./logger"
import { log } from "./logger"

export interface Config {
  llm: {
    apiKey: string
    baseUrl: string
  }
  agent: {
    logLevel: LogLevel
    maxSteps: number
  }
  debug: {
    enabled: boolean
    namespace: string
  }
  trace: {
    enabled: boolean
    exporter: "console" | "otlp" | "zipkin"
  }
}

const VALID_LOG_LEVELS = new Set<string>(["debug", "info", "warn", "error"])
const VALID_TRACE_EXPORTERS = new Set<string>(["console", "otlp", "zipkin"])

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const rawLogLevel = env.AGENT_LOG_LEVEL ?? "info"
  const logLevel: LogLevel = VALID_LOG_LEVELS.has(rawLogLevel) ? (rawLogLevel as LogLevel) : "info"
  if (!VALID_LOG_LEVELS.has(rawLogLevel)) {
    log("warn", "config.invalid_log_level", { rawLogLevel })
  }

  const rawExporter = env.TRACE_EXPORTER ?? "console"
  const exporter = VALID_TRACE_EXPORTERS.has(rawExporter)
    ? (rawExporter as "console" | "otlp" | "zipkin")
    : "console"
  if (!VALID_TRACE_EXPORTERS.has(rawExporter)) {
    log("warn", "config.invalid_trace_exporter", { rawExporter })
  }

  // Default maxSteps matches the butterfly-config default (20).
  // When both config.ts and butterfly-config.ts define a default,
  // butterfly-config takes precedence at the call site. This default
  // only applies when AGENT_MAX_STEPS env var is not set AND the
  // butterfly config doesn't provide a value.
  const maxStepsRaw = env.AGENT_MAX_STEPS !== undefined ? Number(env.AGENT_MAX_STEPS) : 20
  const maxSteps = Number.isFinite(maxStepsRaw) && maxStepsRaw > 0 ? maxStepsRaw : 20
  if (!Number.isFinite(maxStepsRaw) || maxStepsRaw <= 0) {
    log("warn", "config.invalid_max_steps", { rawMaxSteps: env.AGENT_MAX_STEPS })
  }

  return {
    llm: {
      apiKey: (() => {
        const key = env.LLM_API_KEY ?? ""
        if (!key) throw new Error("LLM_API_KEY is required but was not set")
        return key
      })(),
      baseUrl: env.LLM_BASE_URL ?? "",
    },
    agent: { logLevel, maxSteps },
    debug: {
      enabled: env.DEBUG === "true",
      namespace: env.DEBUG_NAMESPACE ?? "butterfly:*",
    },
    trace: {
      enabled: env.TRACE_ENABLED === "true",
      exporter,
    },
  }
}
