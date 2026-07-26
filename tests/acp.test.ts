/**
 * Tests for @butterfly/acp — Agent Client Protocol integration.
 *
 * The ACP package wraps ServerApp in an ACP-compatible Agent interface.
 * These tests verify the interface contract without needing a real ACP SDK
 * connection (which requires ndjson stdio streams).
 *
 * Note: The ACP SDK types are complex and require type casts. This is
 * consistent with the acp package itself which uses the same approach.
 * We cast once per test case to minimize noise.
 */

import { describe, expect, it } from "vitest"
import { createButterflyACP } from "../packages/acp/src/butterfly-acp-agent"

function createAgent() {
  return createButterflyACP(undefined as any, { cwd: "/tmp" })
}

describe("@butterfly/acp — createButterflyACP", () => {
  it("returns an Agent-compatible object", () => {
    const agent = createAgent()
    expect(typeof agent.initialize).toBe("function")
    expect(typeof agent.newSession).toBe("function")
    expect(typeof agent.prompt).toBe("function")
    expect(typeof agent.cancel).toBe("function")
    expect(typeof agent.loadSession).toBe("function")
    expect(typeof agent.setSessionMode).toBe("function")
    expect(typeof agent.authenticate).toBe("function")
  })

  it("initialize returns protocol metadata", async () => {
    const a: any = createAgent()
    const result = await a.initialize({})
    expect(result.protocolVersion).toBe(1)
    expect(result.capabilities).toBeTruthy()
    expect(result.serverInfo.name).toBe("butterfly")
  })

  it("authenticate accepts without auth", async () => {
    const a: any = createAgent()
    const result = await a.authenticate({})
    expect(result).toBeTruthy()
  })

  it("cancel does not throw", async () => {
    const a: any = createAgent()
    await expect(a.cancel({})).resolves.toBeUndefined()
  })

  it("newSession creates a session and returns sessionId", async () => {
    const a: any = createAgent()
    const result = await a.newSession({})
    expect(result.sessionId).toBeTruthy()
    expect(typeof result.sessionId).toBe("string")
  })

  it("prompt with empty prompt returns end_turn", async () => {
    const a: any = createAgent()
    const { sessionId } = await a.newSession({})
    const result = await a.prompt({ sessionId, prompt: "" })
    expect(result.stopReason).toBe("end_turn")
  })

  it("loadSession throws for missing session", async () => {
    const a: any = createAgent()
    await expect(a.loadSession({ sessionId: "nonexistent-session" })).rejects.toThrow(
      "Session not found",
    )
  })
})
