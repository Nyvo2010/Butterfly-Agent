/**
 * Test Fixtures for Butterfly Agent
 *
 * Centralized fixtures for deterministic testing. Only helpers actually
 * imported by test files live here — everything else was removed as dead code.
 */

import type { LLMUsage } from "../packages/llm/src/types"

/** Sample LLM usage report with real token counts (used by server.test.ts). */
export function sampleUsage(): LLMUsage {
  return { promptTokens: 150, completionTokens: 50, totalTokens: 200, usageAvailable: true }
}
