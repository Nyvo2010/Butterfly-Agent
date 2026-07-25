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
 */
export interface ProviderConfig {
  provider: "openai" | "anthropic" | "gemini"
  apiKey: string
  baseURL?: string
  disabled?: boolean
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
    const baseURL = providerCfg.baseURL

    switch (providerCfg.provider) {
      case "anthropic":
        return new AnthropicClient({ apiKey, model: modelId || undefined })
      case "gemini":
        return new GeminiClient({ apiKey, model: modelId || undefined })
      case "openai":
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
