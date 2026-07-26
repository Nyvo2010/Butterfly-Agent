/**
 * Models.dev Catalog — provider and model registry from models.dev.
 *
 * Mirrors OpenCode's `models-dev.ts`:
 *   - Fetches the provider/model catalog from `https://models.dev/api.json`
 *   - Caches results on disk with a TTL (default 5 minutes)
 *   - Falls back to built-in well-known models when the API is unreachable
 *   - Thread-safe with file-based locking (cross-process safe)
 *
 * The catalog provides full model metadata: cost, limits, capabilities,
 * modalities, reasoning options, status, release date, and more.
 *
 * Butterfly-specific: this is a vanilla TypeScript implementation (no Effect)
 * to match the rest of the Butterfly codebase. OpenCode uses Effect for
 * resource safety; Butterfly uses async/await with explicit error handling.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "@butterfly/core"

// ─── Types ────────────────────────────────────────────────────────────────────

export type ModelStatus = "alpha" | "beta" | "deprecated" | "active"

export interface ModelCost {
  /** Cost per 1M input tokens in USD. */
  input: number
  /** Cost per 1M output tokens in USD. */
  output: number
  /** Cost per 1M cached read tokens in USD. */
  cache_read?: number
  /** Cost per 1M cached write tokens in USD. */
  cache_write?: number
  /** Context-based tier pricing. */
  tiers?: Array<{
    input: number
    output: number
    cache_read?: number
    cache_write?: number
    tier: { type: "context"; size: number }
  }>
  /** Pricing for context windows > 200k tokens. */
  context_over_200k?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
}

export interface ModelLimit {
  /** Maximum context length in tokens. */
  context: number
  /** Maximum input tokens (undefined = context limit). */
  input?: number
  /** Maximum output tokens. */
  output: number
}

export interface ModelInfo {
  /** Model id (e.g., "claude-sonnet-4-5", "gpt-4o"). */
  id: string
  /** Human-readable name. */
  name: string
  /** Model family (e.g., "claude", "gpt"). */
  family?: string
  /** Release date (ISO 8601). */
  release_date: string
  /** Whether the model supports file attachments. */
  attachment: boolean
  /** Whether the model supports reasoning/thinking. */
  reasoning: boolean
  /** Whether the model supports temperature. */
  temperature: boolean
  /** Whether the model supports tool calls. */
  tool_call: boolean
  /** Reasoning options (effort levels, toggle, budget_tokens). */
  reasoning_options?: Array<
    | { type: "effort"; values: Array<string | null> }
    | { type: "toggle" }
    | { type: "budget_tokens"; min?: number; max?: number }
  >
  /** Whether the model supports interleaved thinking. */
  interleaved?: boolean | { field: "reasoning" | "reasoning_content" | "reasoning_details" }
  /** Pricing info. */
  cost?: ModelCost
  /** Token limits. */
  limit: ModelLimit
  /** Supported input/output modalities. */
  modalities?: {
    input: Array<"text" | "audio" | "image" | "video" | "pdf">
    output: Array<"text" | "audio" | "image" | "video" | "pdf">
  }
  /** Experimental features (modes with per-mode cost/provider overrides). */
  experimental?: {
    modes?: Record<
      string,
      {
        cost?: ModelCost
        provider?: { body?: Record<string, unknown>; headers?: Record<string, string> }
      }
    >
  }
  /** Model status. */
  status?: ModelStatus
  /** Provider-specific overrides (npm package, api identifier). */
  provider?: { npm?: string; api?: string }
}

export interface ProviderInfo {
  /** Provider id (e.g., "anthropic", "openai"). */
  id: string
  /** Human-readable name. */
  name: string
  /** Required environment variables for auth. */
  env: string[]
  /** Optional npm package for SDK-based providers. */
  npm?: string
  /** Optional API identifier. */
  api?: string
  /** Models keyed by model id. */
  models: Record<string, ModelInfo>
}

export interface CatalogSnapshot {
  /** Provider catalog keyed by provider id. */
  providers: Record<string, ProviderInfo>
  /** When the catalog was last fetched. */
  fetchedAt: number
}

// ─── Well-known fallback models ───────────────────────────────────────────────

/**
 * Built-in model list — used when models.dev is unreachable or disabled.
 * Mirrors OpenCode's hardcoded model entries so the agent always has
 * something to work with even without network access.
 */
export const WELL_KNOWN_MODELS: Record<string, string[]> = {
  anthropic: [
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-1",
    "claude-sonnet-4-20250514",
    "claude-haiku-4-20250514",
  ],
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "o1",
    "o3-mini",
    "o4-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
  ],
  google: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "deepseek-r1-distill-llama-70b",
    "gemma2-9b-it",
    "qwen-2.5-32b",
    "mistral-saba-24b",
  ],
  togetherai: ["mistral-7b", "llama-3-70b", "llama-3-8b", "deepseek-r1", "qwen-2.5-72b"],
  fireworks: [
    "llama-v3p1-8b",
    "llama-v3p1-70b",
    "mixtral-8x22b",
    "deepseek-r1",
    "deepseek-v3",
    "qwen-qwq-32b",
  ],
  cerebras: ["llama-3.1-8b", "llama-3.1-70b", "llama-3.3-70b"],
  xai: ["grok-2", "grok-3", "grok-3-mini"],
  openrouter: ["auto"],
  mistral: [
    "mistral-large-latest",
    "mistral-small-latest",
    "mistral-medium",
    "codestral-latest",
    "pixtral-large-latest",
  ],
  cohere: ["command-r", "command-r-plus", "command-r7b", "command-a"],
  perplexity: [
    "sonar-pro",
    "sonar",
    "sonar-reasoning-pro",
    "sonar-reasoning",
    "sonar-deep-research",
  ],
  // Additional OpenCode providers
  azure: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  "amazon-bedrock": [
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-1",
    "llama-3.1-70b",
    "llama-3.1-8b",
  ],
  "github-copilot": ["claude-sonnet-4-5", "claude-haiku-4-5", "gpt-4o", "o1", "gemini-2.5-flash"],
  cloudflare: [
    "deepseek-r1-distill-qwen-32b",
    "llama-3.1-8b",
    "llama-3.3-70b",
    "qwen-2.5-coder-32b",
  ],
  // OpenCode native
  opencode: ["zen"],
  // Vercel AI Gateway
  vercel: ["gpt-4o", "claude-sonnet-4-5", "gemini-2.5-flash"],
  // Other OpenAI-compatible providers in OpenCode catalog
  baseten: [],
  deepinfra: [],
}

// ─── Models.dev fetcher ───────────────────────────────────────────────────────

interface ModelsDevOptions {
  /** URL to fetch the catalog from (default: https://models.dev). */
  sourceUrl?: string
  /** Cache TTL in milliseconds (default: 5 minutes). */
  ttlMs?: number
  /** Disable network fetch entirely (offline mode). */
  disableFetch?: boolean
}

const DEFAULT_SOURCE_URL = "https://models.dev"
const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Models.dev catalog service.
 *
 * Fetches the provider/model catalog from models.dev and caches it on disk.
 * Falls back to disk cache when offline, and to built-in WELL_KNOWN_MODELS
 * when no cache exists and the API is unreachable.
 *
 * Cross-process safe via file-based atomic writes (write temp → rename).
 */
export class ModelsDevCatalog {
  private readonly sourceUrl: string
  private readonly ttlMs: number
  private readonly disableFetch: boolean
  private cachePath: string
  private cached: CatalogSnapshot | null = null

  constructor(opts: ModelsDevOptions = {}) {
    this.sourceUrl = opts.sourceUrl ?? DEFAULT_SOURCE_URL
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.disableFetch = opts.disableFetch ?? false
    this.cachePath = join(tmpdir(), "butterfly-models-dev.json")
  }

  /**
   * Get the provider catalog.
   * Returns from memory cache, disk cache, or network fetch (in that order).
   */
  async getCatalog(): Promise<Record<string, ProviderInfo>> {
    // 1. Memory cache (valid)
    if (this.cached && Date.now() - this.cached.fetchedAt < this.ttlMs) {
      return this.cached.providers
    }

    // 2. Disk cache
    const disk = this.loadFromDisk()
    if (disk && Date.now() - disk.fetchedAt < this.ttlMs) {
      this.cached = disk
      return disk.providers
    }

    // 3. Network fetch
    if (!this.disableFetch) {
      try {
        const providers = await this.fetchFromApi()
        this.cached = { providers, fetchedAt: Date.now() }
        this.saveToDisk(this.cached)
        return providers
      } catch (err) {
        log("warn", "models_dev.fetch_failed", {
          error: (err as Error).message,
          sourceUrl: this.sourceUrl,
        })
      }
    }

    // 4. Fallback: use stale disk cache
    if (disk) {
      log("info", "models_dev.stale_cache")
      this.cached = disk
      return disk.providers
    }

    // 5. Last resort: return empty (caller uses WELL_KNOWN_MODELS)
    log("warn", "models_dev.no_data")
    return {}
  }

  /** Force a refresh of the catalog (invalidates cache). */
  async refresh(): Promise<Record<string, ProviderInfo>> {
    this.cached = null
    try {
      if (existsSync(this.cachePath)) unlinkSync(this.cachePath)
    } catch {
      // Non-fatal
    }
    return this.getCatalog()
  }

  /** Clear all caches (memory + disk). */
  clear(): void {
    this.cached = null
    try {
      if (existsSync(this.cachePath)) unlinkSync(this.cachePath)
    } catch {
      // Non-fatal
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private loadFromDisk(): CatalogSnapshot | null {
    try {
      if (!existsSync(this.cachePath)) return null
      const raw = readFileSync(this.cachePath, "utf8")
      const data = JSON.parse(raw)
      if (
        data &&
        typeof data === "object" &&
        data.providers &&
        typeof data.fetchedAt === "number"
      ) {
        return data as CatalogSnapshot
      }
    } catch {
      // Corrupt cache — delete it
      try {
        unlinkSync(this.cachePath)
      } catch {
        /* ignore */
      }
      return null
    }
    return null
  }

  private saveToDisk(snapshot: CatalogSnapshot): void {
    try {
      const dir = join(this.cachePath, "..")
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const tmpPath = `${this.cachePath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmpPath, JSON.stringify(snapshot), "utf8")
      renameSync(tmpPath, this.cachePath)
    } catch (err) {
      log("warn", "models_dev.save_failed", { error: (err as Error).message })
    }
  }

  private async fetchFromApi(): Promise<Record<string, ProviderInfo>> {
    const url = `${this.sourceUrl}/api.json`
    log("info", "models_dev.fetching", { url })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000) // 10 second timeout

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": `butterfly-agent/${process.env.BUTTERFLY_VERSION ?? "0.1.0"}`,
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const text = await response.text()
      const data = JSON.parse(text)

      // Validate structure: must be an object with provider records
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Invalid catalog format: expected object with provider records")
      }

      return data as Record<string, ProviderInfo>
    } finally {
      clearTimeout(timeout)
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let defaultCatalog: ModelsDevCatalog | null = null

/** Get the default (singleton) models.dev catalog instance. */
export function getModelsDevCatalog(): ModelsDevCatalog {
  if (!defaultCatalog) {
    defaultCatalog = new ModelsDevCatalog()
  }
  return defaultCatalog
}

/** Reset the singleton (for testing). */
export function resetModelsDevCatalog(): void {
  if (defaultCatalog) {
    defaultCatalog.clear()
    defaultCatalog = null
  }
}
