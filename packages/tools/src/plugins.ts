/**
 * Butterfly Plugin System.
 *
 * Plugins are modules that can extend Butterfly's behavior by registering
 * tools, modifying prompts, and hooking into the agent lifecycle.
 *
 * Plugin format (Opencode-compatible):
 * - Local: .butterfly/plugins/<name>.js or .butterfly/plugins/<name>/index.js
 * - NPM: installed as a dependency, referenced by name
 *
 * Each plugin exports:
 *   export function activate(ctx: PluginContext): Promise<void>
 *   export function deactivate?(): Promise<void>
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ButterflyPluginConfig } from "@butterfly/core"
import { log } from "@butterfly/core"
import type { ToolRegistry } from "./registry"
import type { Tool } from "./types"

// ─── Plugin Context ────────────────────────────────────────────────────────────

export interface PluginContext {
  /** Register a tool into Butterfly's tool registry. */
  registerTool(tool: Tool): void
  /** Remove a previously registered tool. */
  unregisterTool(name: string): void
  /** The plugin's configuration options from butterfly.json. */
  options: Record<string, unknown>
  /** Logger scoped to this plugin. */
  log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ) => void
}

// ─── Plugin Instance ───────────────────────────────────────────────────────────

interface PluginInstance {
  name: string
  activate: (ctx: PluginContext) => Promise<void>
  deactivate?: () => Promise<void>
  active: boolean
}

const loadedPlugins = new Map<string, PluginInstance>()

// ─── Loading ───────────────────────────────────────────────────────────────────

/**
 * Load a plugin from a local path or npm package.
 */
async function loadPluginModule(
  pluginName: string,
  cwd: string,
): Promise<{ activate: (ctx: PluginContext) => Promise<void>; deactivate?: () => Promise<void> }> {
  // Try local path first: .butterfly/plugins/<name>.js
  const localJs = join(cwd, ".butterfly", "plugins", `${pluginName}.js`)
  if (existsSync(localJs)) {
    return await import(localJs)
  }

  // Try local directory: .butterfly/plugins/<name>/index.js
  const localDir = join(cwd, ".butterfly", "plugins", pluginName, "index.js")
  if (existsSync(localDir)) {
    return await import(localDir)
  }

  // Try npm package
  try {
    return await import(pluginName)
  } catch {
    throw new Error(
      `Plugin "${pluginName}" not found. Place it at .butterfly/plugins/${pluginName}.js ` +
        `or install it as an npm dependency.`,
    )
  }
}

/**
 * Activate a single plugin.
 */
export async function activatePlugin(
  config: ButterflyPluginConfig,
  cwd: string,
  registry: ToolRegistry,
): Promise<void> {
  if (config.disabled) return
  if (loadedPlugins.has(config.name)) return // already loaded

  try {
    const mod = await loadPluginModule(config.name, cwd)
    if (!mod.activate) {
      throw new Error(`Plugin "${config.name}" does not export an activate function.`)
    }

    const ctx: PluginContext = {
      registerTool(tool: Tool) {
        registry.register(tool)
      },
      unregisterTool(name: string) {
        registry.remove(name)
      },
      options: config.options ?? {},
      log: (level, message, context) => {
        log(level, `[plugin:${config.name}] ${message}`, context)
      },
    }

    await mod.activate(ctx)

    loadedPlugins.set(config.name, {
      name: config.name,
      activate: mod.activate,
      deactivate: mod.deactivate,
      active: true,
    })

    log("info", `[plugin] Activated: ${config.name}`)
  } catch (err) {
    log("error", `[plugin] Failed to activate ${config.name}: ${(err as Error).message}`)
  }
}

/**
 * Activate all plugins from the config.
 */
export async function activateAllPlugins(
  plugins: ButterflyPluginConfig[],
  cwd: string,
  registry: ToolRegistry,
): Promise<void> {
  for (const plugin of plugins) {
    await activatePlugin(plugin, cwd, registry)
  }
}

/**
 * Deactivate all loaded plugins. Call on shutdown.
 */
export async function deactivateAllPlugins(): Promise<void> {
  for (const [, instance] of loadedPlugins) {
    try {
      await instance.deactivate?.()
    } catch {
      // Best-effort deactivation
    }
  }
  loadedPlugins.clear()
}
