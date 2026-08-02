/**
 * Butterfly config system — Opencode-compatible config format with Butterfly extensions.
 *
 * Config files are loaded from, in priority order:
 * 1. Project-local: .butterfly/config.json (or config.jsonc)
 * 2. Global: ~/.butterfly/config.json
 *
 * The format is maximally compatible with Opencode's opencode.json so users can
 * copy-paste their Opencode config and have it work seamlessly.
 *
 * Butterfly-specific extensions (model tiering, SCE/COE options) live under a
 * "butterfly" key that Opencode simply ignores.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "./logger"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ButterflyMCPConfig {
  /** Command to run the MCP server (e.g., "npx -y @modelcontextprotocol/server-filesystem"). */
  command: string
  /** Arguments to pass to the command. */
  args?: string[]
  /** Environment variables for the server process. */
  env?: Record<string, string>
  /** Working directory for the server. */
  cwd?: string
  /** Remote URL for SSE/HTTP-based MCP servers. */
  url?: string
  /** Headers for remote connections. */
  headers?: Record<string, string>
}

export interface ButterflyPluginConfig {
  /** Plugin name (npm package or path to local module). */
  name: string
  /** Plugin-specific options. */
  options?: Record<string, unknown>
  /** Disable the plugin without removing it from config. */
  disabled?: boolean
}

export interface ButterflyAgentConfig {
  /** Override model for this agent. */
  model?: string
  /** Temperature override. */
  temperature?: number
  /** Max steps override. */
  steps?: number
  /** Mode: plan | build */
  mode?: "plan" | "build"
  /** Description shown in agent list. */
  description?: string
}

/**
 * OpenCode-compatible provider configuration.
 * Supports all major LLM providers, matching OpenCode's provider type list.
 *
 * Extends OpenCode's ConfigProvider.Info with the same fields:
 *   - name: human-readable name (optional)
 *   - env: required environment variables for auth
 *   - api: provider API type (aisdk or native)
 *   - models: per-model overrides (cost, limit, capabilities, request)
 *   - options: provider options forwarded to the adapter
 */
export interface ButterflyProviderConfig {
  /**
   * Provider type: openai, anthropic, google, openai-compatible, deepseek,
   * groq, togetherai, fireworks, cerebras, xai, openrouter, mistral, cohere,
   * perplexity, azure, amazon-bedrock, github-copilot, cloudflare.
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
   * Mirrors OpenCode's provider `env` field. The UI uses this to show
   * which env vars need to be set before a provider is usable.
   */
  env?: string[]
  /**
   * Custom model overrides — map model id to per-model config.
   * Mirrors OpenCode's `ConfigProvider.Info.models`.
   */
  models?: Record<
    string,
    {
      /** Human-readable display name. */
      name?: string
      /** Model family (e.g., "claude", "gpt"). */
      family?: string
      /** Disable this specific model. */
      disabled?: boolean
      /** Per-request provider options (headers + body). */
      request?: {
        headers?: Record<string, string>
        body?: Record<string, unknown>
      }
    }
  >
  /**
   * Provider options forwarded to the LLM adapter.
   * For OpenAI: reasoning_effort, text_verbosity, etc.
   */
  options?: Record<string, unknown>
}

export interface ButterflyPermissionConfig {
  /** File edit permission: "ask" | "allow" | "deny" */
  edit?: "ask" | "allow" | "deny"
  /** Bash execution rules: glob pattern → "ask" | "allow" | "deny" */
  bash?: Record<string, "ask" | "allow" | "deny">
}

/**
 * Full Butterfly config. All Opencode-compatible fields are at the top level.
 * Butterfly-specific extensions live under the "butterfly" key.
 */
export interface ButterflyConfig {
  /** Schema URL for validation (Opencode-compatible). */
  $schema?: string
  /** Default model in provider/model format (e.g., "anthropic/claude-sonnet-4-5"). */
  model?: string
  /** OpenCode-compatible provider configurations keyed by name. */
  providers?: Record<string, ButterflyProviderConfig>
  /** Custom instructions appended to the system prompt. */
  instructions?: string[]
  /** MCP server configurations (Opencode-compatible). */
  mcp?: Record<string, ButterflyMCPConfig>
  /** Plugin configurations (Opencode-compatible). */
  plugin?: ButterflyPluginConfig[]
  /** Custom agent/persona definitions (Opencode-compatible). */
  agent?: Record<string, ButterflyAgentConfig>
  /** Permission rules (Opencode-compatible). */
  permission?: ButterflyPermissionConfig
  /** API key for server authentication. When set, all API requests require Authorization header. */
  apiKey?: string
  /** Butterfly-specific extensions. */
  butterfly?: {
    /** Tiered model mapping for ModelRouter. */
    tiers?: {
      trivial?: string
      standard?: string
      complex?: string
      escalate?: string
    }
    /** SCE (Smart Context Engine) options. */
    sce?: {
      maxFiles?: number
      maxTokensPerFile?: number
      maxGrepResults?: number
      topFiles?: number
    }
    /** COE (Context Optimization Engine) options. */
    coe?: {
      maxContextTokens?: number
      toolMessageMaxTokens?: number
    }
    /** Default max steps before loop termination. */
    maxSteps?: number
    /** Background job tuning. */
    backgroundJobs?: {
      /** Job run interval in ms (default 60s). */
      intervalMs?: number
      /**
       * OPT-IN stale-session cleanup age in ms. Butterfly never deletes
       * sessions unless this is explicitly set to a positive value.
       * 0 / unset = never delete sessions (default).
       */
      staleSessionAgeMs?: number
    }
    /** LSP (Language Server Protocol) integration. Enabled by default. */
    lsp?: {
      /** Set false to disable LSP even when a language server is available. */
      enabled?: boolean
      /** Command + args to spawn the default language server. */
      command?: string | string[]
      /** Request timeout in milliseconds. */
      timeoutMs?: number
      /** Per-language servers routed by file extension. */
      servers?: Record<
        string,
        {
          command: string | string[]
          extensions: string[]
        }
      >
    }
  }
}

// ─── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: ButterflyConfig = {
  model: "anthropic/claude-sonnet-4-5",
  butterfly: {
    tiers: {
      trivial: "anthropic/claude-haiku-4-5",
      standard: "anthropic/claude-sonnet-4-5",
      complex: "anthropic/claude-sonnet-4-5",
      escalate: "anthropic/claude-opus-4-1",
    },
    sce: {
      maxFiles: 5,
      maxTokensPerFile: 2000,
      maxGrepResults: 50,
      topFiles: 3,
    },
    coe: {
      // NOTE: no default maxContextTokens here — when unset, the server derives
      // the budget from the selected model's catalog context window (fallback
      // 8000). See ProviderService.contextBudgetFor. This prevents big-context
      // models from being crushed into a fixed 8k budget.
      toolMessageMaxTokens: 2000,
    },
    maxSteps: 20,
  },
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj
  for (const value of Object.values(obj as Record<string, unknown>)) deepFreeze(value)
  return Object.freeze(obj)
}

deepFreeze(DEFAULT_CONFIG)

// ─── Loading ───────────────────────────────────────────────────────────────────

/**
 * Strip JSON comments (single-line // and multi-line) for JSONC support.
 * Uses a state machine that tracks string literals to avoid stripping `//`
 * that appears inside string values (e.g., URLs like "https://").
 */
function stripJsonComments(raw: string): string {
  // Use a state machine: track whether we're inside a string to avoid
  // stripping `//` that appears inside string literals.
  let result = ""
  let i = 0
  let inString = false
  let isEscaped = false
  while (i < raw.length) {
    const c = raw[i]
    if (isEscaped) {
      result += c
      isEscaped = false
      i++
      continue
    }
    if (c === "\\") {
      result += c
      isEscaped = true
      i++
      continue
    }
    if (c === '"') {
      result += c
      inString = !inString
      i++
      continue
    }
    if (!inString && i + 1 < raw.length && c === "/" && raw[i + 1] === "/") {
      // Single-line comment: skip to actual newline or end-of-file.
      while (i < raw.length && raw[i] !== "\n") i++
      continue
    }
    if (!inString && i + 1 < raw.length && c === "/" && raw[i + 1] === "*") {
      // Multi-line comment: skip to */
      i += 2
      while (i < raw.length - 1) {
        if (raw[i] === "*" && raw[i + 1] === "/") {
          i += 2
          break
        }
        i++
      }
      continue
    }
    result += c
    i++
  }
  return result
}

function loadJsonFile(
  path: string,
  logError?: (msg: string) => void,
): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf8")
    const stripped = stripJsonComments(raw)
    // Validate JSON can be parsed.
    const parsed = JSON.parse(stripped)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logError?.(`Config file ${path} must contain a JSON object, got ${typeof parsed}`)
      return null
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    logError?.(`Failed to load config from ${path}: ${(err as Error).message}`)
    return null
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    // Prevent prototype pollution from user-controlled config files.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue
    const sv = source[key]
    const tv = target[key]
    if (Array.isArray(sv) && Array.isArray(tv)) {
      // Concatenate arrays (e.g., instructions from global + project).
      ;(target[key] as unknown[]) = [...tv, ...sv]
    } else if (
      sv &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>)
    } else if (sv !== undefined) {
      target[key] = sv
    }
  }
}

/**
 * Load Butterfly config from disk, merging global and project-local files.
 * Project-local takes priority over global. Merged with defaults.
 *
 * Lookup order:
 * 1. .butterfly/config.json (or config.jsonc) in cwd
 * 2. ~/.butterfly/config.json (global)
 * 3. Built-in defaults
 */
/**
 * Validate and coerce raw config into a type-safe ButterflyConfig.
 * Applied AFTER merging defaults + global + project configs, so all fields
 * are guaranteed present from DEFAULT_CONFIG. Type-checking here catches
 * user-provided values that were merged over defaults with wrong types
 * (e.g., setting "model" to a number). Such values are silently dropped
 * in favor of defaults since defaults were never overridden with valid data.
 */
function validateButterflyConfig(raw: Record<string, unknown>): ButterflyConfig {
  const config: ButterflyConfig = {}
  if (typeof raw.$schema === "string") config.$schema = raw.$schema
  else if (raw.$schema !== undefined)
    log("warn", "config.invalid_type", {
      field: "$schema",
      expected: "string",
      got: typeof raw.$schema,
    })
  if (typeof raw.model === "string") config.model = raw.model
  else if (raw.model !== undefined)
    log("warn", "config.invalid_type", {
      field: "model",
      expected: "string",
      got: typeof raw.model,
    })
  if (Array.isArray(raw.instructions)) {
    config.instructions = raw.instructions.filter((i): i is string => typeof i === "string")
  } else if (raw.instructions !== undefined)
    log("warn", "config.invalid_type", {
      field: "instructions",
      expected: "array",
      got: typeof raw.instructions,
    })
  if (typeof raw.mcp === "object" && raw.mcp !== null && !Array.isArray(raw.mcp)) {
    const mcp: Record<string, ButterflyMCPConfig> = {}
    for (const [key, val] of Object.entries(raw.mcp)) {
      if (typeof val === "object" && val !== null) {
        const v = val as Record<string, unknown>
        const entry = {} as ButterflyMCPConfig
        if (typeof v.command === "string") entry.command = v.command
        if (Array.isArray(v.args))
          entry.args = v.args.filter((a): a is string => typeof a === "string")
        if (typeof v.env === "object" && v.env !== null) entry.env = v.env as Record<string, string>
        if (typeof v.cwd === "string") entry.cwd = v.cwd
        if (typeof v.url === "string") entry.url = v.url
        if (typeof v.headers === "object" && v.headers !== null)
          entry.headers = v.headers as Record<string, string>
        mcp[key] = entry
      }
    }
    if (Object.keys(mcp).length > 0) config.mcp = mcp
  }
  if (Array.isArray(raw.plugin)) {
    config.plugin = raw.plugin.filter(
      (p): p is ButterflyPluginConfig =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as Record<string, unknown>).name === "string",
    ) as ButterflyPluginConfig[]
  }
  if (typeof raw.agent === "object" && raw.agent !== null && !Array.isArray(raw.agent)) {
    const agent: Record<string, ButterflyAgentConfig> = {}
    for (const [key, val] of Object.entries(raw.agent)) {
      if (typeof val === "object" && val !== null) {
        const v = val as Record<string, unknown>
        const entry: ButterflyAgentConfig = {}
        if (typeof v.model === "string") entry.model = v.model
        if (typeof v.temperature === "number") entry.temperature = v.temperature
        if (typeof v.steps === "number") entry.steps = v.steps
        if (v.mode === "plan" || v.mode === "build") entry.mode = v.mode
        if (typeof v.description === "string") entry.description = v.description
        agent[key] = entry
      }
    }
    if (Object.keys(agent).length > 0) config.agent = agent
  }
  if (typeof raw.apiKey === "string") config.apiKey = raw.apiKey
  else if (raw.apiKey !== undefined)
    log("warn", "config.invalid_type", {
      field: "apiKey",
      expected: "string",
      got: typeof raw.apiKey,
    })
  if (
    typeof raw.permission === "object" &&
    raw.permission !== null &&
    !Array.isArray(raw.permission)
  ) {
    const v = raw.permission as Record<string, unknown>
    const permission: ButterflyPermissionConfig = {}
    if (v.edit === "ask" || v.edit === "allow" || v.edit === "deny") permission.edit = v.edit
    if (typeof v.bash === "object" && v.bash !== null && !Array.isArray(v.bash)) {
      const bash: Record<string, "ask" | "allow" | "deny"> = {}
      for (const [pattern, rule] of Object.entries(v.bash)) {
        if (rule === "ask" || rule === "allow" || rule === "deny") bash[pattern] = rule
      }
      if (Object.keys(bash).length > 0) permission.bash = bash
    }
    config.permission = permission
  }
  // Provider configurations (OpenCode-compatible)
  if (
    typeof raw.providers === "object" &&
    raw.providers !== null &&
    !Array.isArray(raw.providers)
  ) {
    const providers: Record<string, ButterflyProviderConfig> = {}
    for (const [key, val] of Object.entries(raw.providers)) {
      if (typeof val === "object" && val !== null) {
        const v = val as Record<string, unknown>
        const provider = v.provider as string | undefined
        const apiKey = v.apiKey as string | undefined
        const VALID_PROVIDERS = [
          "openai",
          "anthropic",
          "gemini",
          "google",
          "openai-compatible",
          "deepseek",
          "groq",
          "togetherai",
          "fireworks",
          "cerebras",
          "xai",
          "openrouter",
          "mistral",
          "cohere",
          "perplexity",
          "azure",
          "amazon-bedrock",
          "github-copilot",
          "cloudflare",
          "baseten",
          "deepinfra",
          "vercel",
        ]
        if (provider && VALID_PROVIDERS.includes(provider) && typeof apiKey === "string") {
          const models = v.models as Record<string, Record<string, unknown>> | undefined
          const parsedModels: ButterflyProviderConfig["models"] = models
            ? Object.fromEntries(
                Object.entries(models)
                  .filter(([, m]) => typeof m === "object" && m !== null)
                  .map(([mid, m]) => [
                    mid,
                    {
                      name: typeof m.name === "string" ? m.name : undefined,
                      family: typeof m.family === "string" ? m.family : undefined,
                      disabled: m.disabled === true ? true : undefined,
                      request:
                        typeof m.request === "object" && m.request !== null
                          ? {
                              headers:
                                typeof (m.request as Record<string, unknown>).headers === "object"
                                  ? ((m.request as Record<string, unknown>).headers as Record<
                                      string,
                                      string
                                    >)
                                  : undefined,
                              body:
                                typeof (m.request as Record<string, unknown>).body === "object"
                                  ? ((m.request as Record<string, unknown>).body as Record<
                                      string,
                                      unknown
                                    >)
                                  : undefined,
                            }
                          : undefined,
                    },
                  ]),
              )
            : undefined
          providers[key] = {
            provider: provider as ButterflyProviderConfig["provider"],
            apiKey,
            baseURL: typeof v.baseURL === "string" ? v.baseURL : undefined,
            disabled: v.disabled === true ? true : undefined,
            env: Array.isArray(v.env)
              ? v.env.filter((e): e is string => typeof e === "string")
              : undefined,
            models: parsedModels,
            options:
              typeof v.options === "object" && v.options !== null && !Array.isArray(v.options)
                ? (v.options as Record<string, unknown>)
                : undefined,
          }
        }
      }
    }
    if (Object.keys(providers).length > 0) config.providers = providers
  }
  if (typeof raw.butterfly === "object" && raw.butterfly !== null) {
    const bf = raw.butterfly as Record<string, unknown>
    const butterfly: NonNullable<ButterflyConfig["butterfly"]> = {}
    if (typeof bf.tiers === "object" && bf.tiers !== null) {
      const t = bf.tiers as Record<string, unknown>
      butterfly.tiers = {}
      if (typeof t.trivial === "string") butterfly.tiers.trivial = t.trivial
      if (typeof t.standard === "string") butterfly.tiers.standard = t.standard
      if (typeof t.complex === "string") butterfly.tiers.complex = t.complex
      if (typeof t.escalate === "string") butterfly.tiers.escalate = t.escalate
    }
    if (typeof bf.sce === "object" && bf.sce !== null) {
      const s = bf.sce as Record<string, unknown>
      butterfly.sce = {}
      if (typeof s.maxFiles === "number") butterfly.sce.maxFiles = s.maxFiles
      if (typeof s.maxTokensPerFile === "number")
        butterfly.sce.maxTokensPerFile = s.maxTokensPerFile
      if (typeof s.maxGrepResults === "number") butterfly.sce.maxGrepResults = s.maxGrepResults
      if (typeof s.topFiles === "number") butterfly.sce.topFiles = s.topFiles
    }
    if (typeof bf.coe === "object" && bf.coe !== null) {
      const c = bf.coe as Record<string, unknown>
      butterfly.coe = {}
      if (typeof c.maxContextTokens === "number")
        butterfly.coe.maxContextTokens = c.maxContextTokens
      if (typeof c.toolMessageMaxTokens === "number")
        butterfly.coe.toolMessageMaxTokens = c.toolMessageMaxTokens
    }
    if (typeof bf.maxSteps === "number") butterfly.maxSteps = bf.maxSteps
    config.butterfly = butterfly
  }
  return config
}

export function loadButterflyConfig(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): ButterflyConfig {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error(`loadButterflyConfig: cwd must be a non-empty string, got ${typeof cwd}`)
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`loadButterflyConfig: cwd is not a valid directory: ${cwd}`)
  }

  const merged: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<
    string,
    unknown
  >

  const logError = (msg: string) => {
    log("error", `[butterfly-config] ${msg}`)
  }

  // 1. Global config: ~/.butterfly/config.json
  const globalPath = join(homedir(), ".butterfly", "config.json")
  const global =
    loadJsonFile(globalPath, logError) ??
    loadJsonFile(join(homedir(), ".butterfly", "config.jsonc"), logError)
  if (global) deepMerge(merged, global)

  // 2. Project config: .butterfly/config.json (or .jsonc)
  const projectPath = join(cwd, ".butterfly", "config.json")
  const project =
    loadJsonFile(projectPath, logError) ??
    loadJsonFile(join(cwd, ".butterfly", "config.jsonc"), logError)
  if (project) deepMerge(merged, project)

  // 3. Env overrides for the default model
  if (env.BUTTERFLY_MODEL) merged.model = env.BUTTERFLY_MODEL

  // 4. Env overrides for tiers (keeps backward compat with env-based config)
  const tiers = (merged.butterfly as Record<string, unknown> | undefined)?.tiers as
    | Record<string, unknown>
    | undefined
  if (tiers) {
    if (env.BUTTERFLY_MODEL_TRIVIAL) tiers.trivial = env.BUTTERFLY_MODEL_TRIVIAL
    if (env.BUTTERFLY_MODEL_STANDARD) tiers.standard = env.BUTTERFLY_MODEL_STANDARD
    if (env.BUTTERFLY_MODEL_COMPLEX) tiers.complex = env.BUTTERFLY_MODEL_COMPLEX
    if (env.BUTTERFLY_MODEL_ESCALATE) tiers.escalate = env.BUTTERFLY_MODEL_ESCALATE
  }

  // Apply type-safe validation to avoid `as unknown as ButterflyConfig`.
  return validateButterflyConfig(merged)
}

/**
 * Extract user instructions as a single string block for the system prompt.
 */
export function getUserInstructions(config: ButterflyConfig): string {
  const instructions = config.instructions ?? []
  if (instructions.length === 0) return ""
  // Note: uses \n regardless of platform; instructions are config values, not file contents.
  return instructions.join("\n")
}
