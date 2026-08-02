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
  /** OTLP endpoint URL (defaults to OTEL_EXPORTER_OTLP_ENDPOINT env var). */
  otlpEndpoint?: string
  /** Service name for resource attributes (defaults to "butterfly-agent"). */
  serviceName?: string
}

let tracingInitialized = false

// ── Type-safe OTEL module shapes (no @ts-expect-error needed) ─────────────

interface OTELSdkTraceNode {
  NodeTracerProvider: new (config?: {
    spanProcessors?: unknown[]
    resource?: unknown
  }) => {
    addSpanProcessor(processor: unknown): void
    register(): void
  }
}

interface OTELSdkTraceBase {
  ConsoleSpanExporter: new () => unknown
  SimpleSpanProcessor: new (exporter: unknown) => unknown
  BatchSpanProcessor: new (exporter: unknown, config?: { maxQueueSize?: number }) => unknown
}

interface OTELExporterOTLP {
  OTLPTraceExporter: new (config?: { url?: string }) => unknown
}

interface OTELExporterZipkin {
  ZipkinExporter: new (config?: { url?: string }) => unknown
}

interface OTELResources {
  Resource: new (attributes: Record<string, string>) => unknown
}

interface OTELApi {
  resourceFromAttributes?: (attributes: Record<string, string>) => unknown
}

// ── Implementation ────────────────────────────────────────────────────────

export async function initTracing(config: TraceConfig): Promise<void> {
  if (!config.enabled || tracingInitialized) return
  tracingInitialized = true

  // Collect resource attributes for the tracer provider.
  const serviceName = config.serviceName ?? "butterfly-agent"
  let resource: unknown
  try {
    resource = await loadResource(serviceName)
  } catch {
    // Resource is optional — tracing still works without it.
  }

  try {
    // @ts-expect-error - optional dependency
    const otelSdk = (await import("@opentelemetry/sdk-trace-node").catch(
      () => null,
    )) as OTELSdkTraceNode | null
    if (!otelSdk?.NodeTracerProvider) {
      throw makeModuleNotFoundError()
    }

    const provider = new otelSdk.NodeTracerProvider(
      resource ? { resource: resource as OTELSdkTraceNode["NodeTracerProvider"] } : undefined,
    )

    // Select and attach the exporter span processor.
    const processor = await createExporter(config, provider)
    if (processor) {
      provider.register()
      log("info", "tracing.initialized", {
        exporter: config.exporter,
        serviceName,
      })
    }
  } catch (err) {
    const maybeCode = (err as { code?: string }).code
    if (maybeCode === "ERR_MODULE_NOT_FOUND" || isModuleNotFoundError(err as Error)) {
      log("warn", "tracing.packages_missing", {
        hint: "Install @opentelemetry/sdk-trace-node, @opentelemetry/sdk-trace-base, @opentelemetry/resources, @opentelemetry/api, and an exporter package to enable tracing, then remove the @ts-expect-error directive above each optional import.",
      })
    } else {
      log("warn", "tracing.init_failed", { error: (err as Error).message })
    }
    tracingInitialized = false
  }
}

function makeModuleNotFoundError(): Error {
  const err = new Error("OpenTelemetry SDK packages are not installed")
  ;(err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND"
  return err
}

function isModuleNotFoundError(err: Error): boolean {
  const code = (err as { code?: string }).code
  return (
    code === "ERR_MODULE_NOT_FOUND" ||
    err.message.includes("Cannot find module") ||
    err.message.includes("Cannot find package")
  )
}

/** Load a Resource from @opentelemetry/resources, falling back gracefully. */
async function loadResource(serviceName: string): Promise<unknown> {
  try {
    // @ts-expect-error - optional dependency
    const resourcesMod = (await import("@opentelemetry/resources").catch(
      () => null,
    )) as OTELResources | null
    if (resourcesMod?.Resource) {
      return new resourcesMod.Resource({
        "service.name": serviceName,
        "service.version": "0.1.0",
      })
    }
  } catch {
    // Fall back to @opentelemetry/api resource helpers.
  }

  // Try the API-level resource helper as fallback.
  try {
    // @ts-expect-error - optional dependency
    const apiModule = (await import("@opentelemetry/api").catch(() => null)) as OTELApi | null
    if (apiModule?.resourceFromAttributes) {
      return apiModule.resourceFromAttributes({
        "service.name": serviceName,
        "service.version": "0.1.0",
      })
    }
  } catch {
    // Resource is optional.
  }

  return undefined
}

async function createExporter(
  config: TraceConfig,
  provider: {
    addSpanProcessor(processor: unknown): void
    register(): void
  },
): Promise<unknown> {
  switch (config.exporter) {
    case "console": {
      // @ts-expect-error - optional dependency
      const sdkBase = (await import("@opentelemetry/sdk-trace-base").catch(
        () => null,
      )) as OTELSdkTraceBase | null
      if (!sdkBase?.ConsoleSpanExporter) throw makeModuleNotFoundError()
      const exporter = new sdkBase.ConsoleSpanExporter()
      provider.addSpanProcessor(new sdkBase.SimpleSpanProcessor(exporter))
      return exporter
    }
    case "otlp": {
      // @ts-expect-error - optional dependency
      const otlpModule = (await import("@opentelemetry/exporter-trace-otlp-http").catch(
        () => null,
      )) as OTELExporterOTLP | null
      if (!otlpModule?.OTLPTraceExporter) throw makeModuleNotFoundError()
      const exporter = new otlpModule.OTLPTraceExporter(
        config.otlpEndpoint ? { url: config.otlpEndpoint } : undefined,
      )
      // @ts-expect-error - optional dependency
      const sdkBase = (await import("@opentelemetry/sdk-trace-base").catch(
        () => null,
      )) as OTELSdkTraceBase | null
      if (!sdkBase?.BatchSpanProcessor) throw makeModuleNotFoundError()
      provider.addSpanProcessor(new sdkBase.BatchSpanProcessor(exporter, { maxQueueSize: 2048 }))
      return exporter
    }
    case "zipkin": {
      // @ts-expect-error - optional dependency
      const zipkinModule = (await import("@opentelemetry/exporter-zipkin").catch(
        () => null,
      )) as OTELExporterZipkin | null
      if (!zipkinModule?.ZipkinExporter) throw makeModuleNotFoundError()
      const exporter = new zipkinModule.ZipkinExporter()
      // @ts-expect-error - optional dependency
      const sdkBase = (await import("@opentelemetry/sdk-trace-base").catch(
        () => null,
      )) as OTELSdkTraceBase | null
      if (!sdkBase?.BatchSpanProcessor) throw makeModuleNotFoundError()
      provider.addSpanProcessor(new sdkBase.BatchSpanProcessor(exporter))
      return exporter
    }
    default:
      return null
  }
}
