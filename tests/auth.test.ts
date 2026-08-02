/**
 * Tests for @butterfly/server — authentication.
 *
 * Covers the auth module (loadAuthConfig, validateApiKey, checkRequestAuth,
 * isPublicPath) and the HTTP layer's 401 enforcement via createHttpServer.
 */

import { describe, expect, it } from "vitest"
import { ServerApp } from "../packages/server/src/app"
import {
  checkRequestAuth,
  isPublicPath,
  loadAuthConfig,
  validateApiKey,
} from "../packages/server/src/auth"
import { createHttpServer } from "../packages/server/src/http"
import { InMemorySessionStore } from "../packages/session/src/store"

// ─── loadAuthConfig ───────────────────────────────────────────────────────────

describe("@butterfly/server — auth — loadAuthConfig", () => {
  it("disables auth when no key is configured", () => {
    const cfg = loadAuthConfig({})
    expect(cfg.enabled).toBe(false)
    expect(cfg.apiKey).toBeUndefined()
  })

  it("enables auth from the BUTTERFLY_API_KEY env var", () => {
    const cfg = loadAuthConfig({ BUTTERFLY_API_KEY: "secret" })
    expect(cfg.enabled).toBe(true)
    expect(cfg.apiKey).toBe("secret")
  })

  it("falls back to the butterfly config apiKey", () => {
    const cfg = loadAuthConfig({}, "config-key")
    expect(cfg.enabled).toBe(true)
    expect(cfg.apiKey).toBe("config-key")
  })

  it("env var takes precedence over config apiKey", () => {
    const cfg = loadAuthConfig({ BUTTERFLY_API_KEY: "env-key" }, "config-key")
    expect(cfg.apiKey).toBe("env-key")
  })

  it("reads a custom header name from the env", () => {
    const cfg = loadAuthConfig({ BUTTERFLY_AUTH_HEADER: "X-Api-Key" }, "k")
    expect(cfg.headerName).toBe("X-Api-Key")
  })

  it("defaults the header name to Authorization", () => {
    const cfg = loadAuthConfig({}, "k")
    expect(cfg.headerName).toBe("Authorization")
  })
})

// ─── validateApiKey ───────────────────────────────────────────────────────────

describe("@butterfly/server — auth — validateApiKey", () => {
  it("accepts a matching key", () => {
    expect(validateApiKey("secret", { enabled: true, apiKey: "secret" })).toBe(true)
  })

  it("rejects a wrong key", () => {
    expect(validateApiKey("nope", { enabled: true, apiKey: "secret" })).toBe(false)
  })

  it("supports comma-separated keys", () => {
    const cfg = { enabled: true, apiKey: "key1, key2" }
    expect(validateApiKey("key1", cfg)).toBe(true)
    expect(validateApiKey("key2", cfg)).toBe(true)
    expect(validateApiKey("key3", cfg)).toBe(false)
  })

  it("accepts anything when auth is disabled", () => {
    expect(validateApiKey("whatever", { enabled: false })).toBe(true)
  })
})

// ─── checkRequestAuth ─────────────────────────────────────────────────────────

describe("@butterfly/server — auth — checkRequestAuth", () => {
  it("allows all requests when auth is disabled", () => {
    expect(checkRequestAuth({}, { enabled: false })).toEqual({ authenticated: true })
  })

  it("rejects missing auth header", () => {
    const res = checkRequestAuth({}, { enabled: true, apiKey: "secret" })
    expect(res.authenticated).toBe(false)
    expect(res.reason).toContain("Missing")
  })

  it("rejects a non-Bearer header format", () => {
    const res = checkRequestAuth(
      { authorization: "Token abc" },
      { enabled: true, apiKey: "secret" },
    )
    expect(res.authenticated).toBe(false)
    expect(res.reason).toContain("Bearer")
  })

  it("accepts a valid Bearer token", () => {
    const res = checkRequestAuth(
      { authorization: "Bearer secret" },
      { enabled: true, apiKey: "secret" },
    )
    expect(res.authenticated).toBe(true)
  })

  it("rejects an invalid Bearer token", () => {
    const res = checkRequestAuth(
      { authorization: "Bearer wrong" },
      { enabled: true, apiKey: "secret" },
    )
    expect(res.authenticated).toBe(false)
  })

  it("honors a custom header name", () => {
    const res = checkRequestAuth(
      { "x-api-key": "Bearer secret" },
      { enabled: true, apiKey: "secret", headerName: "X-Api-Key" },
    )
    expect(res.authenticated).toBe(true)
  })
})

// ─── isPublicPath ─────────────────────────────────────────────────────────────

describe("@butterfly/server — auth — isPublicPath", () => {
  it("marks /health as public", () => {
    expect(isPublicPath("/health")).toBe(true)
  })

  it("marks /openapi.json as public for client discovery", () => {
    expect(isPublicPath("/openapi.json")).toBe(true)
  })

  it("requires auth for API paths", () => {
    expect(isPublicPath("/api/sessions")).toBe(false)
    expect(isPublicPath("/api/event")).toBe(false)
  })
})

// ─── HTTP integration ─────────────────────────────────────────────────────────

describe("@butterfly/server — auth — HTTP layer", () => {
  it("returns 401 for unauthenticated API requests and 200 with a valid key", async () => {
    const app = new ServerApp({
      cwd: "/tmp",
      skipIntegrations: true,
      config: {
        llm: { apiKey: "test", baseUrl: "" },
        agent: { logLevel: "info", maxSteps: 20 },
        debug: { enabled: false, namespace: "butterfly:*" },
        trace: { enabled: false, exporter: "console" },
      },
      authConfig: { enabled: true, apiKey: "secret" },
      store: new InMemorySessionStore(),
    })
    const handle = createHttpServer(app)
    await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", resolve))
    const address = handle.server.address() as { port: number }
    const base = `http://127.0.0.1:${address.port}`

    try {
      // /health is public.
      const health = await fetch(`${base}/health`)
      expect(health.status).toBe(200)

      // /api/sessions without a token -> 401.
      const unauth = await fetch(`${base}/api/sessions`)
      expect(unauth.status).toBe(401)

      // /api/sessions with a wrong token -> 401.
      const wrong = await fetch(`${base}/api/sessions`, {
        headers: { Authorization: "Bearer wrong" },
      })
      expect(wrong.status).toBe(401)

      // /api/sessions with the correct token -> 200.
      const ok = await fetch(`${base}/api/sessions`, {
        headers: { Authorization: "Bearer secret" },
      })
      expect(ok.status).toBe(200)

      // /openapi.json is public (client discovery) even with auth on.
      const spec = await fetch(`${base}/openapi.json`)
      expect(spec.status).toBe(200)
      const specJson = (await spec.json()) as { openapi?: string; paths?: object }
      expect(specJson.openapi).toBe("3.0.3")
      expect(specJson.paths).toBeTruthy()
    } finally {
      handle.server.closeAllConnections?.()
      await new Promise<void>((resolve) => handle.server.close(() => resolve()))
      await app.dispose()
    }
  })
})
