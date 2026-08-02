/**
 * Tests for @butterfly/client — typed HTTP + SSE SDK.
 *
 * Uses a mock fetch to verify the request/response contract without a live
 * server. Covers session CRUD, prompt, providers, files, and error handling.
 */

import { afterEach, describe, expect, it } from "vitest"
import { ApiError, createButterflyClient } from "../packages/client/src"

// ── Mock fetch helper ────────────────────────────────────────────────────────

function makeFetch(handler: (url: URL, init?: RequestInit) => unknown): typeof fetch {
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input))
    const body = handler(url, init)
    // Treat explicit error responses (an object with a numeric `error` field)
    // as failures; anything else is a 200 with the payload as the JSON body.
    const isError =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
    const status = isError ? ((body as { error: string; status?: number }).status ?? 404) : 200
    const payload = isError ? body : body
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as Response
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("@butterfly/client — request layer", () => {
  afterEach(() => {
    // no-op; keep for symmetry
  })

  it("health returns parsed body", async () => {
    const client = createButterflyClient({
      baseUrl: "http://localhost:3000",
      fetch: makeFetch(() => ({ status: "ok", uptime: 1, activeRuns: 0, model: "m", routes: 1 })),
    })
    const h = await client.health()
    expect(h.status).toBe("ok")
    expect(h.routes).toBe(1)
  })

  it("sends Authorization header when apiKey is set", async () => {
    let captured: RequestInit | undefined
    const client = createButterflyClient({
      baseUrl: "http://localhost:3000",
      apiKey: "secret-key",
      fetch: makeFetch((_url, init) => {
        captured = init
        return { sessions: [], nextCursor: null }
      }),
    })
    await client.sessions.list()
    expect(captured?.headers).toMatchObject({ Authorization: "Bearer secret-key" })
  })

  it("throws ApiError on non-2xx responses", async () => {
    const client = createButterflyClient({
      baseUrl: "http://localhost:3000",
      fetch: makeFetch(() => ({ status: 404, error: "Session not found: nope" })),
    })
    await expect(client.sessions.get("nope")).rejects.toThrow(ApiError)
    await expect(client.sessions.get("nope")).rejects.toThrow("Session not found: nope")
  })
})

describe("@butterfly/client — endpoints", () => {
  it("sessions.list passes query params", async () => {
    let lastUrl: URL | undefined
    const client = createButterflyClient({
      baseUrl: "http://localhost:3000",
      fetch: makeFetch((url) => {
        lastUrl = url
        return { sessions: [], nextCursor: null }
      }),
    })
    await client.sessions.list({ limit: 25, archived: true })
    expect(lastUrl?.searchParams.get("limit")).toBe("25")
    expect(lastUrl?.searchParams.get("archived")).toBe("true")
  })

  it("sessions.create POSTs JSON body", async () => {
    let captured: { url: URL; init: RequestInit } | undefined
    const client = createButterflyClient({
      baseUrl: "http://localhost:3000",
      fetch: makeFetch((url, init) => {
        captured = { url, init: init ?? {} }
        return { session: { id: "s-1", mode: "build", tier: "standard" } }
      }),
    })
    const res = await client.sessions.create({
      mode: "build",
      selectedModel: "anthropic/claude-sonnet-4-5",
    })
    expect(res.session.id).toBe("s-1")
    expect(captured?.init.method).toBe("POST")
    const body = JSON.parse(String(captured?.init.body))
    expect(body.selectedModel).toBe("anthropic/claude-sonnet-4-5")
  })

  it("prompt passes query wait and body", async () => {
    let captured: { url: URL; init: RequestInit } | undefined
    const client = createButterflyClient({
      baseUrl: "http://localhost:3000",
      fetch: makeFetch((url, init) => {
        captured = { url, init: init ?? {} }
        return { sessionId: "s-1", status: "completed", iterations: 1 }
      }),
    })
    const res = await client.prompt("s-1", "do the thing", { wait: true, maxSteps: 5 })
    expect(res.status).toBe("completed")
    expect(captured?.url.searchParams.get("wait")).toBe("true")
    const body = JSON.parse(String(captured?.init.body))
    expect(body.prompt).toBe("do the thing")
    expect(body.maxSteps).toBe(5)
  })

  it("providers returns catalog shape", async () => {
    const client = createButterflyClient({
      baseUrl: "http://localhost:3000",
      fetch: makeFetch(() => ({
        providers: [{ id: "anthropic", name: "Anthropic", prefix: "anthropic/" }],
        models: [
          { id: "anthropic/claude-sonnet-4-5", name: "claude-sonnet-4-5", provider: "anthropic" },
        ],
        current: "anthropic/claude-sonnet-4-5",
        autoAvailable: true,
      })),
    })
    const catalog = await client.providers()
    expect(catalog.providers).toHaveLength(1)
    expect(catalog.models[0].id).toBe("anthropic/claude-sonnet-4-5")
    expect(catalog.autoAvailable).toBe(true)
  })

  it("files.read returns content", async () => {
    const client = createButterflyClient({
      baseUrl: "http://localhost:3000",
      fetch: makeFetch(() => ({ path: "foo.ts", content: "export const x = 1", size: 20 })),
    })
    const file = await client.files.read("foo.ts")
    expect(file.content).toContain("export const x")
    expect(file.size).toBe(20)
  })

  it("permissions.reply POSTs answer", async () => {
    let capturedInit: RequestInit | undefined
    const client = createButterflyClient({
      baseUrl: "http://localhost:3000",
      fetch: makeFetch((_url, init) => {
        capturedInit = init
        return { resolved: true, answer: "yes" }
      }),
    })
    const res = await client.permissions.reply("perm-1", "yes")
    expect(res.resolved).toBe(true)
    expect(capturedInit?.method).toBe("POST")
    const body = JSON.parse(String(capturedInit?.body))
    expect(body.answer).toBe("yes")
  })
})

describe("@butterfly/client — SSE parsing", () => {
  it("openEventStream parses server-sent events", async () => {
    const { openEventStream } = await import("../packages/client/src")
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'id: evt-1\ndata: {"id":"evt-1","kind":"session.created","type":"session","timestamp":"t","sessionId":"s1","data":{"mode":"build"}}\n\n' +
              ": keepalive\n\n" +
              'id: evt-2\ndata: {"id":"evt-2","kind":"tool.start","type":"tool","sessionId":"s1","data":{"tool":"read"}}\n\n',
          ),
        )
        controller.close()
      },
    })
    ;(globalThis as { fetch?: unknown }).fetch = (async () => ({
      ok: true,
      status: 200,
      body: sseBody,
    })) as unknown as typeof fetch

    const originalFetch = globalThis.fetch
    try {
      const events: Array<{ id: string; kind: string }> = []
      const handle = openEventStream("http://localhost:3000/api/event", {
        onEvent: (e) => events.push({ id: e.id, kind: e.kind }),
      })
      await handle.ready
      await new Promise((r) => setTimeout(r, 20))
      handle.close()
      expect(events).toHaveLength(2)
      expect(events[0].kind).toBe("session.created")
      expect(events[1].kind).toBe("tool.start")
    } finally {
      ;(globalThis as { fetch?: unknown }).fetch = originalFetch
    }
  })
})
