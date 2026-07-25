import { AnthropicClient } from "./anthropic-adapter"
import { GeminiClient } from "./gemini-adapter"
import type { LLMClient } from "./types"
import { VercelAILLMClient } from "./vercel-adapter"

export type { AnthropicClientOptions } from "./anthropic-adapter"
export { AnthropicClient } from "./anthropic-adapter"
export type { GeminiClientOptions } from "./gemini-adapter"
export { GeminiClient } from "./gemini-adapter"
export { ForgivingToolCallParser } from "./parser"
export type {
  LLMClient,
  LLMContentPart,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMStream,
  LLMStreamEvent,
  LLMToolSpec,
  LLMUsage,
  ToolCallParser,
} from "./types"
export type { VercelAILLMClientOptions } from "./vercel-adapter"
export { VercelAILLMClient } from "./vercel-adapter"

/**
 * Provider configuration — OpenCode-compatible.
 * Each provider has a type, API key, and optional base URL.
 * Supports: openai, anthropic, gemini, openai-compatible, deepseek, groq,
 * togetherai, fireworks, cerebras, xai, openrouter, mistral, cohere, perplexity.
 */
export interface ProviderConfig {
  provider:
    | "openai"
    | "anthropic"
    | "gemini"
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
  apiKey: string
  baseURL?: string
  disabled?: boolean
}

/**
 * Known provider profiles with default base URLs.
 * Mirrors OpenCode's openai-compatible profile system.
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
}

/**
 * Create the appropriate LLM client.
 *
 * Priority:
 * 1. If `providers` map is provided, look up the provider name from the model prefix.
 *    Model format: "provider-name/model-id" (e.g., "anthropic/claude-sonnet-4").
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
    const apiKey = providerCfg.apiKey || cfg.apiKey
    const baseURL = providerCfg.baseURL || PROVIDER_PROFILES[providerCfg.provider]?.baseURL

    switch (providerCfg.provider) {
      case "anthropic":
        return new AnthropicClient({ apiKey, model: modelId || undefined })
      case "gemini":
        return new GeminiClient({ apiKey, model: modelId || undefined })
      case "openai":
        return new VercelAILLMClient({ apiKey, baseUrl: baseURL || cfg.baseUrl || undefined })
      // All OpenAI-compatible providers use the Vercel AI SDK client.
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
        return new VercelAILLMClient({ apiKey, baseUrl: baseURL || cfg.baseUrl || undefined })
    }
  }

  // Fallback: legacy prefix-based routing with env var credentials.
  switch (prefix) {
    case "anthropic":
      return new AnthropicClient({ apiKey: cfg.apiKey, model: modelId || undefined })
    case "gemini":
    case "google":
      return new GeminiClient({ apiKey: cfg.apiKey, model: modelId || undefined })
    default:
      return new VercelAILLMClient({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl || undefined,
      })
  }
}
