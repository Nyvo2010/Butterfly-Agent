import type { LLMClient, LLMRequest, LLMResponse, LLMUsage } from "./types"

export type LLMScript = LLMResponse[] | ((req: LLMRequest) => LLMResponse | Promise<LLMResponse>)

export class MockLLMClient implements LLMClient {
  constructor(private readonly script: LLMScript) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (Array.isArray(this.script)) {
      const next = this.script.shift()
      if (!next) {
        throw new Error("MockLLMClient: script exhausted")
      }
      return next
    }
    return this.script(req)
  }
}

export function zeroUsage(): LLMUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
}

export function textResponse(text: string, usage: LLMUsage = zeroUsage()): LLMResponse {
  return { kind: "text", text, usage }
}

export function toolCallResponse(
  calls: Array<{ id: string; name: string; input: unknown }>,
  usage: LLMUsage = zeroUsage(),
): LLMResponse {
  return { kind: "tool_calls", calls, usage }
}
