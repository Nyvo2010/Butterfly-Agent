/**
 * Live LLM integration tests — OPT-IN, skipped by default.
 *
 * These tests exercise the real provider path (streaming, retries, tool-call
 * parsing) end-to-end against a live LLM API. They are intentionally NOT part
 * of the default `pnpm test` run because they require network access, an API
 * key, and cost money.
 *
 * Run with:
 *   BUTTERFLY_TEST_LIVE=1 LLM_API_KEY=sk-... LLM_BASE_URL=https://... pnpm test
 *   # or just the live tests:
 *   BUTTERFLY_TEST_LIVE=1 LLM_API_KEY=sk-... npx vitest run tests/live-llm.test.ts
 *
 * The default model is read from BUTTERFLY_MODEL (or falls back to a small
 * cheap OpenAI-compatible model). Configure BUTTERFLY_MODEL_STANDARD etc. to
 * control tier models.
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { loadButterflyConfig } from "../core/src/butterfly-config"
import { loadConfig } from "../core/src/config"
import { loadDotEnv } from "../core/src/dotenv"
import type { AgentFactoryOptions } from "../packages/agent/src/factory"
import { createAgent } from "../packages/agent/src/factory"
import { GPTTokenizer } from "../packages/context/src"
import { createClient } from "../packages/llm/src/client"
import { InMemorySessionStore } from "../packages/session/src"
import { createSession } from "../packages/session/src/types"

// ── Opt-in gate ───────────────────────────────────────────────────────────────

function loadEnv(): void {
  // Try the project .env files so local dev keys work out of the box.
  loadDotEnv(".env")
  loadDotEnv("core/.env")
}

loadEnv()

const LIVE = process.env.BUTTERFLY_TEST_LIVE === "1"
const HAS_KEY = Boolean(process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY)

const describeLive = LIVE && HAS_KEY ? describe : describe.skip

// ── Shared setup ─────────────────────────────────────────────────────────────

let disposed: Array<() => Promise<void>> = []

afterAll(async () => {
  await Promise.allSettled(disposed.map((d) => d()))
  disposed = []
})

function defaultModel(): string {
  return process.env.BUTTERFLY_MODEL ?? "deepseek/deepseek-chat"
}

async function makeAgent(model = defaultModel(), cwd = process.cwd()) {
  const config = loadConfig()
  const butterflyConfig = loadButterflyConfig(cwd)
  const tokenizer = new GPTTokenizer()
  tokenizer.warmup()
  const store = new InMemorySessionStore()
  const llm = createClient(model, config.llm, butterflyConfig.providers)

  // Full factory: registers all standard tools (write/bash/patch). For the
  // loop test we pass an isolated temp dir as cwd so a real model can never
  // touch the repository — build mode grants it file-mutating tools.
  const opts: AgentFactoryOptions = {
    cwd,
    llm,
    tokenizer,
    store,
    config: butterflyConfig,
  }
  const agent = await createAgent(opts)
  disposed.push(() => agent.dispose())
  return { agent, store, llm }
}

describeLive("Live LLM integration", () => {
  it("completes a simple text request", async () => {
    const { llm } = await makeAgent()
    const response = await llm.complete({
      model: defaultModel(),
      system: "You are a terse assistant. Reply in one short sentence.",
      messages: [{ role: "user", content: "Say hello." }],
    })
    expect(response.kind).toBe("text")
    if (response.kind === "text") {
      expect(response.text.length).toBeGreaterThan(0)
    }
  })

  it("streams a completion with text deltas", async () => {
    const { llm } = await makeAgent()
    if (!llm.completeStream) throw new Error("Live client does not support streaming")
    const stream = await llm.completeStream({
      model: defaultModel(),
      system: "You are a terse assistant.",
      messages: [{ role: "user", content: "Count from 1 to 3." }],
    })
    const deltas: string[] = []
    for await (const event of stream) {
      if (event.kind === "text_delta") deltas.push(event.text)
      if (event.kind === "error") throw new Error(`Stream error: ${event.message}`)
    }
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.join("").length).toBeGreaterThan(0)
  })

  it("runs a full agent loop with a real model", async () => {
    // Isolated temp cwd: the loop runs in build mode with write/bash tools
    // registered, so it must never operate on the repository.
    const sandbox = await mkdtemp(join(tmpdir(), "bf-live-"))
    const { agent } = await makeAgent(defaultModel(), sandbox)
    const session = createSession("live-loop", "build")
    const result = await agent.loop.run({
      session,
      query: "Reply with exactly: READY",
      cwd: sandbox,
      maxSteps: 3,
    })
    expect(result.stopReason).not.toBe("error")
    const lastMsg = result.session.messages[result.session.messages.length - 1]
    expect(lastMsg?.role).toBe("assistant")
  })

  it("emits stream.usage with real token counts", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "bf-live-"))
    const { agent } = await makeAgent(defaultModel(), sandbox)
    const session = createSession("live-usage", "build")
    const result = await agent.loop.run({
      session,
      query: "Reply with exactly: OK",
      cwd: sandbox,
      maxSteps: 2,
    })
    expect(result.session.usage?.usageAvailable).toBe(true)
    expect(result.session.usage?.totalTokens).toBeGreaterThan(0)
  })
})
