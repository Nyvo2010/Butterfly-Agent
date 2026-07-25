/**
 * OpenTelemetry tracing integration for Butterfly Agent.
 *
 * When TRACE_ENABLED=true, sets up OpenTelemetry SDK with the configured
 * exporter (console, otlp, or zipkin). All subsystems automatically
 * participate via Node.js auto-instrumentation.
 *
 * Usage:
 *   import { initTracing } from "@butterfly/core"
 *   await initTracing(config.trace)
 *
 * Requires @opentelemetry packages to be installed. Falls back gracefully
 * when they're not available — tracing is an optional enhancement.
 */

import { log } from "./logger"

export interface TraceConfig {
  enabled: boolean
  exporter: "console" | "otlp" | "zipkin"
}

let tracingInitialized = false

export async function initTracing(config: TraceConfig): Promise<void> {
  if (!config.enabled || tracingInitialized) return
  tracingInitialized = true

  try {
    // Dynamic imports — OTEL packages are optional dependencies.
    // @ts-expect-error - optional dependency, may not be installed
    const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node")

    const provider = new NodeTracerProvider()

    // Select exporter based on config.
    const processor = await createExporter(config.exporter, provider)
    if (processor) {
      provider.register()
      log("info", "tracing.initialized", { exporter: config.exporter })
    }
  } catch (err) {
    const maybeCode = (err as { code?: string }).code
    if (maybeCode === "ERR_MODULE_NOT_FOUND") {
      log("warn", "tracing.packages_missing", {
        hint: "Install @opentelemetry/sdk-trace-node, @opentelemetry/sdk-trace-base, and an exporter package to enable tracing.",
      })
    } else {
      log("warn", "tracing.init_failed", { error: (err as Error).message })
    }
    tracingInitialized = false
  }
}

async function createExporter(
  type: TraceConfig["exporter"],
  provider: { addSpanProcessor: (p: unknown) => void },
): Promise<unknown> {
  switch (type) {
    case "console": {
      // @ts-expect-error - optional dependency, may not be installed
      const sdkBase = await import("@opentelemetry/sdk-trace-base")
      const exporter = new sdkBase.ConsoleSpanExporter()
      provider.addSpanProcessor(new sdkBase.SimpleSpanProcessor(exporter))
      return exporter
    }
    case "otlp": {
      // @ts-expect-error - optional dependency, may not be installed
      const otlpModule = await import("@opentelemetry/exporter-trace-otlp-http")
      const exporter = new otlpModule.OTLPTraceExporter()
      // @ts-expect-error - optional dependency, may not be installed
      const sdkBase = await import("@opentelemetry/sdk-trace-base")
      provider.addSpanProcessor(new sdkBase.BatchSpanProcessor(exporter))
      return exporter
    }
    case "zipkin": {
      // @ts-expect-error - optional dependency, may not be installed
      const zipkinModule = await import("@opentelemetry/exporter-zipkin")
      const exporter = new zipkinModule.ZipkinExporter()
      // @ts-expect-error - optional dependency, may not be installed
      const sdkBase = await import("@opentelemetry/sdk-trace-base")
      provider.addSpanProcessor(new sdkBase.BatchSpanProcessor(exporter))
      return exporter
    }
    default:
      return null
  }
}
