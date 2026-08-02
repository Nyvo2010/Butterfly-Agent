/**
 * LLM Client factory — creates the appropriate LLMClient for a given model string.
 *
 * Extracted from index.ts to avoid circular dependencies with provider.ts.
 * Both index.ts (re-exports) and provider.ts (ProviderService) import from here.
 *
 * Mirrors OpenCode's provider system:
 *   - Providers are configured in butterfly.json under the "providers" key
 *   - Each provider has a type, API key, optional base URL, env vars, and models
 *   - OpenAI-compatible providers use shared profiles (like openai-compatible-profile.ts)
 *   - Native providers (anthropic, gemini) use their own adapters
 */

import { AnthropicClient } from "./anthropic-adapter"
import { GeminiClient } from "./gemini-adapter"
import type { LLMClient, ModelRequestOverrideMap } from "./types"
import { VercelAILLMClient } from "./vercel-adapter"

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Provider configuration — OpenCode-compatible.
 *
 * Each provider has a type, API key, optional base URL, optional environment
 * variables for auth, and optional model overrides.
 *
 * Supported provider types match OpenCode's full provider catalog.
 */
export interface ProviderConfig {
  /**
   * Provider type. Must match one of the supported provider types.
   * Maps to the adapter used for actual LLM calls.
   */
  provider:
    | "openai"
    | "anthropic"
    | "gemini"
    | "google"
    | "openai-compatible"
    | "deepseek"
    | "groq"
    | "togetherai"
    | "fireworks"
    | "cerebras"
    | "xai"
    | "openrouter"
    | "mistral"
    | "cohere"
    | "perplexity"
    | "azure"
    | "amazon-bedrock"
    | "github-copilot"
    | "cloudflare"
    | "baseten"
    | "deepinfra"
    | "vercel"
  /** API key for this provider. */
  apiKey: string
  /** Optional base URL override (for proxies, self-hosted, etc.). */
  baseURL?: string
  /** Disable this provider without removing it from config. */
  disabled?: boolean
  /**
   * Required environment variable names for auth.
   * Mirrors OpenCode's provider `env` field. Used by the UI to show
   * which env vars need to be set before a provider is usable.
   */
  env?: string[]
  /**
   * Custom model overrides — map model id to per-model config.
   * Mirrors OpenCode's `ConfigProvider.Info.models`.
   *
   * Each override can set model-specific: name, cost, limit, family,
   * status, capabilities, and provider-specific request overrides
   * (headers, body). This is how users customize model metadata for
   * their specific deployment (e.g., Azure model names, Bedrock model IDs).
   */
  models?: Record<
    string,
    {
      /** Human-readable display name. */
      name?: string
      /** Model family (e.g., "claude", "gpt"). */
      family?: string
      /** Override model capabilities. */
      toolCall?: boolean
      /** Override reasoning support. */
      reasoning?: boolean
      /** Pricing override (per 1M tokens). */
      cost?: { input: number; output: number }
      /** Token limit override. */
      limit?: { context: number; output: number }
      /** Model status: alpha, beta, deprecated, active. */
      status?: string
      /** Per-request provider options (headers + body). */
      request?: {
        headers?: Record<string, string>
        body?: Record<string, unknown>
      }
      /** Disable this specific model. */
      disabled?: boolean
    }
  >
  /**
   * Provider options forwarded to the LLM adapter.
   * For OpenAI: reasoning_effort, text_verbosity, etc.
   * For OpenRouter: openrouter.usage, openrouter.reasoning, etc.
   */
  options?: Record<string, unknown>
}

// ─── Provider Profiles ────────────────────────────────────────────────────────

/**
 * Known provider profiles with default base URLs.
 * Mirrors OpenCode's `openai-compatible-profile.ts`.
 */
export const PROVIDER_PROFILES: Record<string, { baseURL: string }> = {
  deepseek: { baseURL: "https://api.deepseek.com/v1" },
  groq: { baseURL: "https://api.groq.com/openai/v1" },
  togetherai: { baseURL: "https://api.together.xyz/v1" },
  fireworks: { baseURL: "https://api.fireworks.ai/inference/v1" },
  cerebras: { baseURL: "https://api.cerebras.ai/v1" },
  xai: { baseURL: "https://api.x.ai/v1" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1" },
  mistral: { baseURL: "https://api.mistral.ai/v1" },
  cohere: { baseURL: "https://api.cohere.ai/v1" },
  perplexity: { baseURL: "https://api.perplexity.ai" },
  // Additional OpenCode providers:
  baseten: { baseURL: "https://inference.baseten.co/v1" },
  deepinfra: { baseURL: "https://api.deepinfra.com/v1/openai" },
  vercel: { baseURL: "https://api.vercel.ai/v1" },
  cloudflare: { baseURL: "https://api.cloudflare.com/client/v4/accounts" },
}

/**
 * Provider-specific API key environment variable names.
 * Used as fallback when no explicit apiKey is provided.
 */
export const PROVIDER_ENV_VARS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
  togetherai: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cohere: "COHERE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  "amazon-bedrock": "AWS_ACCESS_KEY_ID",
  "github-copilot": "GITHUB_TOKEN",
  cloudflare: "CLOUDFLARE_API_KEY",
  baseten: "BASETEN_API_KEY",
  deepinfra: "DEEPINFRA_API_KEY",
  vercel: "VERCEL_API_KEY",
}

// ─── Model id helpers ─────────────────────────────────────────────────────────

/**
 * Extract the bare model id from a possibly-prefixed model string.
 *
 * Model references may arrive as "provider/model" (e.g. "anthropic/claude-sonnet-4-5")
 * from the router/tier mapping, while the underlying provider APIs expect only the
 * model id ("claude-sonnet-4-5"). Mirrors the prefix-stripping in `createClient`
 * (first segment only), so openrouter-style "provider/org/model" ids are preserved.
 */
export function bareModelId(model: string): string {
  const idx = model.indexOf("/")
  if (idx === -1) return model
  return model.slice(idx + 1)
}

// ─── Client factory ───────────────────────────────────────────────────────────

/**
 * Create the appropriate LLM client.
 *
 * Priority:
 * 1. If `providers` map is provided, look up the provider name from the model prefix.
 *    Model format: "provider-name/model-id" (e.g., "anthropic/claude-sonnet-4-5").
 * 2. Fall back to the legacy `cfg.apiKey` + `cfg.baseUrl` env-var-based config.
 *
 * This is OpenCode-compatible: users configure providers in butterfly.json
 * under the "providers" key, and models reference them by name.
 */
export function createClient(
  model: string,
  cfg: { apiKey: string; baseUrl: string },
  providers?: Record<string, ProviderConfig>,
): LLMClient {
  const [prefix, ...modelParts] = model.split("/")
  const modelId = modelParts.join("/") || model

  // Look up provider config by prefix if providers are configured.
  const providerCfg = providers?.[prefix]

  if (providerCfg && !providerCfg.disabled) {
    return createClientFromConfig(providerCfg, modelId, cfg)
  }

  // Fallback: legacy prefix-based routing with env var credentials.
  switch (prefix) {
    case "anthropic":
      return new AnthropicClient({
        apiKey: cfg.apiKey || process.env.ANTHROPIC_API_KEY || "",
        model: modelId || undefined,
      })
    case "gemini":
    case "google":
      return new GeminiClient({
        apiKey: cfg.apiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
        model: modelId || undefined,
      })
    // All OpenAI-compatible providers use the Vercel AI SDK client.
    case "openai":
    case "deepseek":
    case "groq":
    case "togetherai":
    case "fireworks":
    case "cerebras":
    case "xai":
    case "openrouter":
    case "mistral":
    case "cohere":
    case "perplexity":
    case "azure":
    case "baseten":
    case "deepinfra":
    case "vercel":
    case "cloudflare":
      return new VercelAILLMClient({
        apiKey: cfg.apiKey || "",
        baseUrl: cfg.baseUrl || PROVIDER_PROFILES[prefix]?.baseURL || undefined,
      })
    case "amazon-bedrock":
      return new VercelAILLMClient({
        apiKey: cfg.apiKey || process.env.AWS_ACCESS_KEY_ID || "",
        baseUrl: cfg.baseUrl || undefined,
      })
    case "github-copilot":
      return new VercelAILLMClient({
        apiKey: cfg.apiKey || process.env.GITHUB_TOKEN || "",
        baseUrl: cfg.baseUrl || "https://api.githubcopilot.com",
      })
    default:
      // Unknown prefix: treat as a raw model id with the Vercel AI client.
      return new VercelAILLMClient({
        apiKey: cfg.apiKey || "",
        baseUrl: cfg.baseUrl || undefined,
      })
  }
}

/** Build the per-model request override map from a provider config. */
function buildModelOverrides(providerCfg: ProviderConfig): ModelRequestOverrideMap {
  const overrides: ModelRequestOverrideMap = {}
  if (!providerCfg.models) return overrides
  for (const [modelId, model] of Object.entries(providerCfg.models)) {
    if (model.request && (model.request.headers || model.request.body)) {
      overrides[modelId] = {
        headers: model.request.headers,
        body: model.request.body,
      }
    }
  }
  return overrides
}

/** Create a client from a specific provider config entry. */
function createClientFromConfig(
  providerCfg: ProviderConfig,
  modelId: string,
  cfg: { apiKey: string; baseUrl: string },
): LLMClient {
  const apiKey = providerCfg.apiKey || cfg.apiKey
  const baseURL = providerCfg.baseURL || PROVIDER_PROFILES[providerCfg.provider]?.baseURL
  const modelOverrides = buildModelOverrides(providerCfg)
  const options = providerCfg.options ?? {}

  switch (providerCfg.provider) {
    case "anthropic":
      return new AnthropicClient({
        apiKey,
        model: modelId || undefined,
        options,
        modelOverrides,
      })
    case "gemini":
    case "google":
      return new GeminiClient({
        apiKey,
        model: modelId || undefined,
        options,
        modelOverrides,
      })
    // OpenAI and all compatible providers use the Vercel AI SDK client.
    case "openai":
    case "openai-compatible":
    case "deepseek":
    case "groq":
    case "togetherai":
    case "fireworks":
    case "cerebras":
    case "xai":
    case "openrouter":
    case "mistral":
    case "cohere":
    case "perplexity":
    case "azure":
    case "amazon-bedrock":
    case "github-copilot":
    case "cloudflare":
    case "baseten":
    case "deepinfra":
    case "vercel":
      return new VercelAILLMClient({
        apiKey,
        baseUrl: baseURL || cfg.baseUrl || undefined,
        options,
        modelOverrides,
      })
    default:
      return new VercelAILLMClient({
        apiKey,
        baseUrl: baseURL || cfg.baseUrl || undefined,
        options,
        modelOverrides,
      })
  }
}
