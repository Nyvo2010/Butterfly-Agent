/**
 * Provider route group — list supported LLM providers + model catalog.
 *
 * The client needs to know which providers are available, which models each
 * provider offers, and which model/configuration is current.
 * Inspired by OpenCode's provider + model catalog route group.
 *
 * Returns:
 *   - providers: list of provider summaries with id, name, prefix, modelCount, env
 *   - models: full model catalog across all providers (for model picker UI)
 *   - current: the default model from config
 *
 * Uses models.dev catalog when available (enriched with cost, limits, capabilities).
 * Falls back to built-in well-known models when catalog is unreachable.
 */

import type { ServerApp } from "../app"
import type { Router } from "../router"
import { ok } from "../router"

export function registerProviderRoutes(router: Router, app: ServerApp): void {
  // ── List providers + model catalog ─────────────────────────────────────
  router.get("/api/providers", async (_ctx) => {
    // biome-ignore lint/suspicious/noExplicitAny: types inferred from ProviderService
    let providers: any
    // biome-ignore lint/suspicious/noExplicitAny: types inferred from ProviderService
    let models: any
    try {
      // Try async catalog first (models.dev).
      providers = await app.providerService.listProviders()
      models = await app.providerService.listModels()
    } catch {
      // Fall back to synchronous built-in models.
      providers = app.providerService.listProvidersSync()
      models = app.providerService.listModelsSync()
    }
    ok(_ctx.res, {
      providers,
      models,
      current: app.butterflyConfig.model ?? "",
      // "auto" mode is always available as a model choice
      autoAvailable: true,
    })
  })

  // ── List models only ───────────────────────────────────────────────────
  router.get("/api/models", async (_ctx) => {
    // biome-ignore lint/suspicious/noExplicitAny: types inferred from ProviderService
    let models: any
    try {
      models = await app.providerService.listModels()
    } catch {
      models = app.providerService.listModelsSync()
    }
    ok(_ctx.res, { models, autoAvailable: true })
  })

  // ── List models for a specific provider ─────────────────────────────────
  router.get("/api/models/:provider", async (_ctx) => {
    const providerName = _ctx.params.provider
    if (!providerName) {
      ok(_ctx.res, { models: [], error: "Missing provider name" })
      return
    }
    // biome-ignore lint/suspicious/noExplicitAny: types inferred from ProviderService
    let models: any
    try {
      models = await app.providerService.listModels()
    } catch {
      models = app.providerService.listModelsSync()
    }
    const filtered = models.filter((m: { provider: string }) => m.provider === providerName)
    ok(_ctx.res, { models: filtered, provider: providerName })
  })
}
