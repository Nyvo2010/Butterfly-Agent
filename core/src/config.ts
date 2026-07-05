// Config layer: all process.env access must go through here.
// No subsystem may read process.env directly.

export interface Config {
  llm: {
    apiKey: string
    baseUrl: string
  }
  agent: {
    logLevel: string
    maxSteps: number
  }
  debug: {
    enabled: boolean
    namespace: string
  }
  trace: {
    enabled: boolean
    exporter: string
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    llm: {
      apiKey: env.LLM_API_KEY ?? "",
      baseUrl: env.LLM_BASE_URL ?? "",
    },
    agent: {
      logLevel: env.AGENT_LOG_LEVEL ?? "info",
      maxSteps: Number(env.AGENT_MAX_STEPS) || 10,
    },
    debug: {
      enabled: env.DEBUG === "true",
      namespace: env.DEBUG_NAMESPACE ?? "butterfly:*",
    },
    trace: {
      enabled: env.TRACE_ENABLED === "true",
      exporter: env.TRACE_EXPORTER ?? "console",
    },
  }
}
