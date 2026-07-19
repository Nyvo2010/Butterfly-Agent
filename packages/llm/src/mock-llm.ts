import type { LLMClient, LLMRequest, LLMResponse, LLMStream, LLMUsage } from "./types"

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

  async completeStream(req: LLMRequest): Promise<LLMStream> {
    const response = await this.complete(req)
    // eslint-disable-next-line require-yield
    return (async function* () {
      if (response.kind === "text") {
        for (const char of response.text) {
          yield { kind: "text_delta" as const, text: char }
        }
      } else {
        for (const call of response.calls) {
          yield { kind: "tool_call_delta" as const, id: call.id, name: call.name, input: call.input }
        }
      }
      yield { kind: "done" as const, usage: response.usage, finishReason: "stop" }
    })()
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
