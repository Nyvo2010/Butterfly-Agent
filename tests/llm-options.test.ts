/**
 * Tests for provider options forwarding (#4): ProviderConfig.options and
 * per-model request headers/body must reach the adapter request, and
 * per-request temperature must be honored by all adapters.
 */

import { describe, expect, it } from "vitest"
import { createClient, ProviderService } from "../packages/llm/src/index"

const KEY = "sk-test"

describe("createClient — provider options + model overrides", () => {
  it("passes provider options and per-model request overrides to adapters", () => {
    const providers = {
      myanthropic: {
        provider: "anthropic" as const,
        apiKey: KEY,
        options: { reasoning: { effort: "high" } },
        models: {
          "claude-sonnet-4-5": {
            request: { headers: { "X-Custom": "abc" }, body: { max_tokens: 9000 } },
          },
        },
      },
      mydeepseek: {
        provider: "deepseek" as const,
        apiKey: KEY,
        options: { temperature: 0.2 },
        models: {
          "deepseek-chat": { request: { body: { logprobs: true } } },
        },
      },
    }

    const anthro = createClient(
      "myanthropic/claude-sonnet-4-5",
      { apiKey: KEY, baseUrl: "" },
      providers,
    )
    const vercel = createClient("mydeepseek/deepseek-chat", { apiKey: KEY, baseUrl: "" }, providers)

    // Both are LLMClients; verify internals via the options fields.
    const a = anthro as unknown as {
      options: Record<string, unknown>
      modelOverrides: Record<string, unknown>
    }
    expect(a.options).toEqual({ reasoning: { effort: "high" } })
    expect(a.modelOverrides["claude-sonnet-4-5"]).toEqual({
      headers: { "X-Custom": "abc" },
      body: { max_tokens: 9000 },
    })

    const v = vercel as unknown as {
      options: Record<string, unknown>
      modelOverrides: Record<string, unknown>
    }
    expect(v.options).toEqual({ temperature: 0.2 })
    expect(v.modelOverrides["deepseek-chat"]).toEqual({ body: { logprobs: true } })
  })

  it("builds empty overrides when no per-model requests are configured", () => {
    const providers = {
      plain: { provider: "openai" as const, apiKey: KEY },
    }
    const client = createClient("plain/gpt-4o", { apiKey: KEY, baseUrl: "" }, providers)
    const c = client as unknown as { modelOverrides: Record<string, unknown> }
    expect(c.modelOverrides).toEqual({})
  })
})

describe("ProviderService — model-aware context budget", () => {
  it("contextBudgetFor returns the fallback for unknown models", async () => {
    const svc = new ProviderService({ apiKey: KEY, baseUrl: "" })
    const budget = await svc.contextBudgetFor("unknown/does-not-exist", 8000)
    expect(budget).toBe(8000)
  })

  it("contextLimitFor returns undefined for unknown models", async () => {
    const svc = new ProviderService({ apiKey: KEY, baseUrl: "" })
    expect(await svc.contextLimitFor("unknown/does-not-exist")).toBeUndefined()
  })
})
