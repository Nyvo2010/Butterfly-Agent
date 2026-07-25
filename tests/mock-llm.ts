/**
 * Mock LLM Client for testing the Agent Loop deterministically.
 *
 * Takes a script — either a pre-defined array of responses (consumed in order
 * via shift()) or a function. Throws if the array is exhausted.
 */
import type { LLMClient, LLMRequest, LLMResponse, LLMUsage } from "../packages/llm/src/types"

export type LLMScript = LLMResponse[] | ((req: LLMRequest) => LLMResponse | Promise<LLMResponse>)

export function zeroUsage(): LLMUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, usageAvailable: false }
}

export function textResponse(text: string, usage?: LLMUsage): LLMResponse {
  return { kind: "text", text, usage: usage ?? zeroUsage() }
}

export function toolCallResponse(
  calls: Array<{ id: string; name: string; input: unknown }>,
  usage?: LLMUsage,
): LLMResponse {
  return { kind: "tool_calls", calls, usage: usage ?? zeroUsage() }
}

export class MockLLMClient implements LLMClient {
  private script: LLMScript
  private idx = 0

  constructor(script: LLMScript) {
    this.script = script
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (typeof this.script === "function") {
      return this.script(req)
    }
    if (this.idx >= this.script.length) {
      throw new Error(`MockLLMClient: script exhausted at index ${this.idx}`)
    }
    return this.script[this.idx++]
  }

  /** Return how many responses have been consumed. */
  get consumed(): number {
    return this.idx
  }
}
