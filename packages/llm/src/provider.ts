/**
 * Provider Service — OpenCode-compatible provider registry + model catalog.
 *
 * Centralizes provider configuration, client creation (with caching), and
 * model discovery. Mirrors OpenCode's provider service pattern where:
 *   - Providers are configured in butterfly.json under the "providers" key
 *   - Models are referenced as "provider-name/model-id" strings
 *   - The client is created dynamically based on the selected model
 *   - A model catalog exposes all available models across all providers
 *   - models.dev API is the primary source of model metadata (with fallback)
 *
 * This is what enables users to choose from every connected provider's models
 * (plus an "auto" option that uses tiered routing from butterfly config).
 */

import { bareModelId, createClient, type ProviderConfig } from "./client"
import {
  type ModelInfo as CatalogModelInfo,
  getModelsDevCatalog,
  WELL_KNOWN_MODELS,
} from "./models-dev"
import type { LLMClient } from "./types"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModelSummary {
  /** Unique model id in "provider/model" format (e.g., "anthropic/claude-sonnet-4-5"). */
  id: string
  /** Human-readable model name. */
  name: string
  /** Provider name (e.g., "anthropic", "openai"). */
  provider: string
  /** Whether this model is from the built-in well-known list. */
  builtin: boolean
  /** Model family (e.g., "claude", "gpt") — from catalog when available. */
  family?: string
  /** Cost per 1M tokens (input/output) — from catalog when available. */
  cost?: { input: number; output: number }
  /** Token limits — from catalog when available. */
  limit?: { context: number; output: number }
  /** Model status: alpha, beta, deprecated, active. */
  status?: string
  /** Whether the model supports tool calls. */
  toolCall?: boolean
  /** Whether the model supports reasoning/thinking. */
  reasoning?: boolean
}

export interface ProviderSummary {
  /** Provider id (e.g., "anthropic"). */
  id: string
  /** Human-readable name. */
  name: string
  /** Provider type (e.g., "anthropic", "openai"). */
  provider: string
  /** Prefix for model references (e.g., "anthropic/"). */
  prefix: string
  /** Override base URL if set. */
  baseURL?: string
  /** Number of known models for this provider. */
  modelCount: number
  /** Required environment variables (from catalog when available). */
  env?: string[]
}

// ─── Provider defaults ───────────────────────────────────────────────────────

/** Well-known provider entries shared by listProviders() and listProvidersSync(). */
const DEFAULT_PROVIDER_ENTRIES: Array<{
  id: string
  name: string
  provider: string
  env: string[]
}> = [
  { id: "anthropic", name: "Anthropic", provider: "anthropic", env: ["ANTHROPIC_API_KEY"] },
  {
    id: "google",
    name: "Google Gemini",
    provider: "google",
    env: ["GOOGLE_GENERATIVE_AI_API_KEY"],
  },
  { id: "openai", name: "OpenAI", provider: "openai", env: ["OPENAI_API_KEY"] },
  { id: "deepseek", name: "DeepSeek", provider: "deepseek", env: ["DEEPSEEK_API_KEY"] },
  { id: "groq", name: "Groq", provider: "groq", env: ["GROQ_API_KEY"] },
  { id: "xai", name: "xAI", provider: "xai", env: ["XAI_API_KEY"] },
  { id: "openrouter", name: "OpenRouter", provider: "openrouter", env: ["OPENROUTER_API_KEY"] },
  { id: "mistral", name: "Mistral", provider: "mistral", env: ["MISTRAL_API_KEY"] },
  { id: "cohere", name: "Cohere", provider: "cohere", env: ["COHERE_API_KEY"] },
  { id: "perplexity", name: "Perplexity", provider: "perplexity", env: ["PERPLEXITY_API_KEY"] },
  { id: "cerebras", name: "Cerebras", provider: "cerebras", env: ["CEREBRAS_API_KEY"] },
  { id: "fireworks", name: "Fireworks", provider: "fireworks", env: ["FIREWORKS_API_KEY"] },
  { id: "togetherai", name: "Together AI", provider: "togetherai", env: ["TOGETHER_API_KEY"] },
]

/** Additional providers only surfaced in the sync (always-on) listing. */
const EXTENDED_PROVIDER_ENTRIES: Array<{
  id: string
  name: string
  provider: string
  env: string[]
}> = [
  { id: "azure", name: "Azure OpenAI", provider: "azure", env: ["AZURE_OPENAI_API_KEY"] },
  {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    provider: "amazon-bedrock",
    env: ["AWS_ACCESS_KEY_ID"],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    provider: "github-copilot",
    env: ["GITHUB_TOKEN"],
  },
  { id: "cloudflare", name: "Cloudflare", provider: "cloudflare", env: ["CLOUDFLARE_API_KEY"] },
]

/** Build a ProviderSummary from a default entry, enriching with catalog data when available. */
function toProviderSummary(
  entry: { id: string; name: string; provider: string; env: string[] },
  catalogName?: string,
  catalogEnv?: string[],
): ProviderSummary {
  return {
    id: entry.id,
    name: catalogName ?? entry.name,
    provider: entry.provider,
    prefix: `${entry.id}/`,
    modelCount: (WELL_KNOWN_MODELS[entry.id] ?? []).length || 1,
    env: catalogEnv ?? entry.env,
  }
}

// ─── Provider Service ─────────────────────────────────────────────────────────

export class ProviderService {
  private readonly clientCache = new Map<string, LLMClient>()

  constructor(
    private readonly config: { apiKey: string; baseUrl: string },
    private readonly providers?: Record<string, ProviderConfig>,
  ) {}

  /**
   * Get or create an LLM client for the given model string.
   * Clients are cached by provider prefix (e.g., "anthropic", "openai/gpt-4o").
   */
  getClient(model: string): LLMClient {
    const prefix = model.split("/")[0]
    const cached = this.clientCache.get(prefix)
    if (cached) return cached

    const client = createClient(model, this.config, this.providers)
    this.clientCache.set(prefix, client)
    return client
  }

  /**
   * List all available models across all providers.
   *
   * Priority:
   * 1. models.dev catalog (fetched + cached on disk)
   * 2. Well-known built-in models per provider type
   * 3. Configured provider models (user's butterfly.json "providers" key)
   *
   * Returns detailed model summaries including cost, limits, and capabilities
   * when available from the catalog.
   */
  async listModels(): Promise<ModelSummary[]> {
    const models: ModelSummary[] = []
    const seen = new Set<string>()

    // 1. Try the models.dev catalog first.
    const catalog = getModelsDevCatalog()
    try {
      const catalogProviders = await catalog.getCatalog()
      if (Object.keys(catalogProviders).length > 0) {
        for (const [providerId, providerInfo] of Object.entries(catalogProviders)) {
          for (const [modelId, modelInfo] of Object.entries(providerInfo.models)) {
            const id = `${providerId}/${modelId}`
            if (seen.has(id)) continue
            seen.add(id)
            models.push(this.catalogModelToSummary(id, providerId, modelId, modelInfo))
          }
        }
        // If we got catalog data, merge configured providers and return.
        this.mergeConfiguredProviderModels(models, seen)
        return models
      }
    } catch {
      // Catalog fetch failed — fall back to built-in models.
    }

    // 2. Fallback: well-known models for all known provider types.
    for (const [provider, modelIds] of Object.entries(WELL_KNOWN_MODELS)) {
      for (const modelId of modelIds) {
        const id = `${provider}/${modelId}`
        if (seen.has(id)) continue
        seen.add(id)
        models.push({
          id,
          name: modelId,
          provider,
          builtin: true,
          toolCall: true,
        })
      }
    }

    // 3. Merge configured providers.
    this.mergeConfiguredProviderModels(models, seen)

    return models
  }

  /**
   * Synchronous version of listModels() that only uses built-in models.
   * Use when async context is not available (e.g., HTTP handler without await).
   */
  listModelsSync(): ModelSummary[] {
    const models: ModelSummary[] = []
    const seen = new Set<string>()

    // Well-known models for all known provider types.
    for (const [provider, modelIds] of Object.entries(WELL_KNOWN_MODELS)) {
      for (const modelId of modelIds) {
        const id = `${provider}/${modelId}`
        if (seen.has(id)) continue
        seen.add(id)
        models.push({
          id,
          name: modelId,
          provider,
          builtin: true,
          toolCall: true,
        })
      }
    }

    this.mergeConfiguredProviderModels(models, seen)
    return models
  }

  /**
   * Get a list of provider summaries for the client UI.
   * Returns provider id, name, prefix, available model count, and required env vars.
   */
  async listProviders(): Promise<ProviderSummary[]> {
    const hasProviders = this.providers && Object.keys(this.providers).length > 0

    // Try catalog first for provider names + env vars.
    const catalogProviderMap = new Map<string, { name: string; env: string[] }>()
    try {
      const catalogProviders = await getModelsDevCatalog().getCatalog()
      for (const [id, info] of Object.entries(catalogProviders)) {
        catalogProviderMap.set(id, { name: info.name, env: info.env })
      }
    } catch {
      // Fall back to built-in names.
    }

    if (hasProviders) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by hasProviders check above
      return Object.entries(this.providers!)
        .filter(([, c]) => !c.disabled)
        .map(([name, c]) => {
          const modelCount = (WELL_KNOWN_MODELS[c.provider] ?? []).length
          const cat = catalogProviderMap.get(c.provider)
          return {
            id: name,
            name: cat?.name ?? `${name} (${c.provider})`,
            provider: c.provider,
            prefix: `${name}/`,
            baseURL: c.baseURL,
            modelCount: modelCount > 0 ? modelCount : 1,
            env: cat?.env ?? c.env,
          }
        })
    }

    // Fallback: legacy env-var-based defaults.
    return DEFAULT_PROVIDER_ENTRIES.map((d) => {
      const cat = catalogProviderMap.get(d.id)
      return toProviderSummary(d, cat?.name, cat?.env)
    })
  }

  /**
   * Synchronous version of listProviders() for non-async contexts.
   */
  listProvidersSync(): ProviderSummary[] {
    const allEntries = [...DEFAULT_PROVIDER_ENTRIES, ...EXTENDED_PROVIDER_ENTRIES]
    return allEntries.map((d) => toProviderSummary(d))
  }

  /** Clear the client cache. */
  clearCache(): void {
    this.clientCache.clear()
  }

  /**
   * Resolve a model's context window (tokens) from the catalog, when known.
   * Returns undefined when the model is unknown or the catalog is unavailable
   * (callers fall back to their configured/default budget).
   */
  async contextLimitFor(model: string): Promise<number | undefined> {
    const prefix = model.split("/")[0]
    const bare = bareModelId(model)
    try {
      const catalog = getModelsDevCatalog()
      const providers = await catalog.getCatalog()
      const provider = providers[prefix]
      const info = provider?.models?.[bare]
      const context = info?.limit?.context
      return typeof context === "number" && context > 0 ? context : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Resolve per-1M-token USD pricing for a model, when known.
   *
   * Priority:
   * 1. Configured provider model override (user's butterfly.json "providers"
   *    key — they may run a proxy with different pricing).
   * 2. models.dev catalog pricing.
   * 3. undefined (unknown model → callers skip cost tracking).
   */
  async costFor(model: string): Promise<{ input: number; output: number } | undefined> {
    const prefix = model.split("/")[0]
    const bare = bareModelId(model)

    // 1. Configured override wins (proxy pricing, self-hosted gateways).
    const cfgModel = this.providers?.[prefix]?.models?.[bare]
    if (cfgModel?.cost) return cfgModel.cost

    // 2. Catalog pricing (bounded wait so cost never blocks a run).
    try {
      const providers = await withTimeout(
        getModelsDevCatalog().getCatalog(),
        750,
        {} as Record<string, never>,
      )
      const info = providers[prefix]?.models?.[bare]
      if (info?.cost) return { input: info.cost.input, output: info.cost.output }
    } catch {
      // Fall through — unknown pricing.
    }
    return undefined
  }

  /**
   * Resolve a sensible COE context budget (tokens) for a model.
   *
   * Small-model focus: when the catalog knows the model's context window, the
   * budget is a conservative fraction of it (so 128k models aren't crushed into
   * an 8k budget). Unknown models fall back to `fallback` (default 8000), which
   * matches the small-model-friendly COE default.
   */
  async contextBudgetFor(
    model: string,
    fallback = 8000,
    fraction = 0.7,
    timeoutMs = 750,
  ): Promise<number> {
    // The catalog lookup can hit the network on a cold start (models.dev fetch).
    // Bounding the wait keeps the first prompt snappy; the catalog is cached on
    // disk afterward, so subsequent calls resolve from cache instantly.
    const limit = await withTimeout(this.contextLimitFor(model), timeoutMs, undefined)
    if (limit === undefined) return fallback
    return Math.max(1000, Math.floor(limit * fraction))
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private catalogModelToSummary(
    id: string,
    providerId: string,
    _modelId: string,
    model: CatalogModelInfo,
  ): ModelSummary {
    return {
      id,
      name: model.name,
      provider: providerId,
      builtin: false,
      family: model.family,
      cost: model.cost ? { input: model.cost.input, output: model.cost.output } : undefined,
      limit: { context: model.limit.context, output: model.limit.output },
      status: model.status ?? "active",
      toolCall: model.tool_call,
      reasoning: model.reasoning,
    }
  }

  private mergeConfiguredProviderModels(models: ModelSummary[], seen: Set<string>): void {
    if (!this.providers) return

    for (const [name, cfg] of Object.entries(this.providers)) {
      if (cfg.disabled) continue

      // If the user configured custom models, add them (skip disabled models).
      if (cfg.models) {
        for (const [modelId, modelOverride] of Object.entries(cfg.models)) {
          if (modelOverride.disabled) continue
          const id = `${name}/${modelId}`
          if (seen.has(id)) continue
          seen.add(id)
          models.push({
            id,
            name: modelOverride.name ?? modelId,
            provider: name,
            builtin: false,
            family: modelOverride.family,
            cost: modelOverride.cost,
            limit: modelOverride.limit,
            status: modelOverride.status,
            toolCall: modelOverride.toolCall,
            reasoning: modelOverride.reasoning,
          })
        }
      }

      // Also surface well-known models for this provider type under the config name.
      const wellKnown = WELL_KNOWN_MODELS[cfg.provider] ?? []
      for (const modelId of wellKnown) {
        const id = `${name}/${modelId}`
        if (seen.has(id)) continue
        seen.add(id)
        models.push({
          id,
          name: modelId,
          provider: name,
          builtin: true,
          toolCall: true,
        })
      }
    }
  }
}

// ── Module helpers ────────────────────────────────────────────────────────────

/**
 * Race a promise against a timeout, resolving to `fallback` when the timeout
 * fires first. The timer is always cleared so repeated calls (per LLM response)
 * never accumulate dangling timers that keep the event loop alive.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
