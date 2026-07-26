/**
 * Config route group — read and update Butterfly configuration.
 *
 * The client needs to display and edit config (model selection, providers,
 * permission rules, SCE/COE tuning). Inspired by OpenCode's config route group.
 * Writes are in-memory only here — persisting config to disk is a future task.
 */

import type { ServerApp } from "../app"
import type { Router } from "../router"
import { ok } from "../router"

export function registerConfigRoutes(router: Router, app: ServerApp): void {
  // ── Get config ─────────────────────────────────────────────────────────
  router.get("/api/config", (_ctx) => {
    // Return a redacted config (no API keys).
    const { config } = app
    ok(_ctx.res, {
      model: app.butterflyConfig.model ?? "",
      providers: Object.fromEntries(
        Object.entries(app.butterflyConfig.providers ?? {}).map(([name, p]) => [
          name,
          { provider: p.provider, baseURL: p.baseURL, disabled: p.disabled },
        ]),
      ),
      permission: app.butterflyConfig.permission,
      butterfly: app.butterflyConfig.butterfly,
      agent: { logLevel: config.agent.logLevel, maxSteps: config.agent.maxSteps },
    })
  })

  // ── Get config providers ───────────────────────────────────────────────
  router.get("/api/config/providers", (_ctx) => {
    ok(_ctx.res, {
      providers: Object.fromEntries(
        Object.entries(app.butterflyConfig.providers ?? {}).map(([name, p]) => [
          name,
          { provider: p.provider, baseURL: p.baseURL, disabled: p.disabled },
        ]),
      ),
      current: app.butterflyConfig.model ?? "",
    })
  })
}
