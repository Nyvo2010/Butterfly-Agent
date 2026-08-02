export { AnthropicClient, type AnthropicClientOptions } from "./anthropic-adapter"
// Re-export from client.ts (shared module to avoid circular deps with provider.ts)
export {
  bareModelId,
  createClient,
  PROVIDER_ENV_VARS,
  PROVIDER_PROFILES,
  type ProviderConfig,
} from "./client"
// Failure classification for retry + escalation policy
export {
  type ClassifiedFailure,
  classifyFailure,
  type FailureCategory,
  failureMessage,
  isRetryable,
  sleep,
} from "./failure"
export { GeminiClient, type GeminiClientOptions } from "./gemini-adapter"
// models.dev catalog integration (OpenCode-compatible)
export {
  type CatalogSnapshot,
  getModelsDevCatalog,
  type ModelCost as CatalogModelCost,
  type ModelInfo as CatalogModelInfo,
  type ModelLimit as CatalogModelLimit,
  type ModelStatus as CatalogModelStatus,
  ModelsDevCatalog,
  type ProviderInfo as CatalogProviderInfo,
  resetModelsDevCatalog,
  WELL_KNOWN_MODELS,
} from "./models-dev"
export { ForgivingToolCallParser } from "./parser"
// ProviderService for dynamic model selection + model catalog (OpenCode-compatible)
export {
  type ModelSummary,
  ProviderService,
  type ProviderSummary,
} from "./provider"
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
  ModelRequestOverrideMap,
  ModelRequestOverrides,
  ToolCallParser,
} from "./types"
export { VercelAILLMClient, type VercelAILLMClientOptions } from "./vercel-adapter"
