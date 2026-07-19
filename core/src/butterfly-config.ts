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

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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
  /** Mode: plan | build | orchestrator */
  mode?: "plan" | "build" | "orchestrator"
  /** Description shown in agent list. */
  description?: string
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
      maxContextTokens: 8000,
      toolMessageMaxTokens: 2000,
    },
    maxSteps: 20,
  },
}

// ─── Loading ───────────────────────────────────────────────────────────────────

/** Strip JSON comments (// and /*) for JSONC support. */
function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
}

function loadJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf8")
    return JSON.parse(stripJsonComments(raw))
  } catch {
    return null
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = target[key]
    if (Array.isArray(sv) && Array.isArray(tv)) {
      // Concatenate arrays (e.g., instructions from global + project).
      ;(target[key] as unknown[]) = [...tv, ...sv]
    } else if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
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
export function loadButterflyConfig(cwd: string, env: Record<string, string | undefined> = process.env): ButterflyConfig {
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>

  // 1. Global config: ~/.butterfly/config.json
  const globalPath = join(homedir(), ".butterfly", "config.json")
  const global = loadJsonFile(globalPath) ?? loadJsonFile(join(homedir(), ".butterfly", "config.jsonc"))
  if (global) deepMerge(merged, global)

  // 2. Project config: .butterfly/config.json (or .jsonc)
  const projectPath = join(cwd, ".butterfly", "config.json")
  const project = loadJsonFile(projectPath) ?? loadJsonFile(join(cwd, ".butterfly", "config.jsonc"))
  if (project) deepMerge(merged, project)

  // 3. Env overrides for the default model
  if (env.BUTTERFLY_MODEL) merged.model = env.BUTTERFLY_MODEL

  // 4. Env overrides for tiers (keeps backward compat with env-based config)
  const tiers = (merged.butterfly as Record<string, unknown> | undefined)?.tiers as Record<string, unknown> | undefined
  if (tiers) {
    if (env.BUTTERFLY_MODEL_TRIVIAL) tiers.trivial = env.BUTTERFLY_MODEL_TRIVIAL
    if (env.BUTTERFLY_MODEL_STANDARD) tiers.standard = env.BUTTERFLY_MODEL_STANDARD
    if (env.BUTTERFLY_MODEL_COMPLEX) tiers.complex = env.BUTTERFLY_MODEL_COMPLEX
    if (env.BUTTERFLY_MODEL_ESCALATE) tiers.escalate = env.BUTTERFLY_MODEL_ESCALATE
  }

  return merged as unknown as ButterflyConfig
}

/**
 * Extract user instructions as a single string block for the system prompt.
 */
export function getUserInstructions(config: ButterflyConfig): string {
  const instructions = config.instructions ?? []
  if (instructions.length === 0) return ""
  return instructions.join("\n")
}
