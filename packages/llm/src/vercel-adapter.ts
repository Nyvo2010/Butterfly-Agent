import { createOpenAI } from "@ai-sdk/openai"
import { generateText, jsonSchema, streamText } from "ai"
import type {
  LLMClient,
  LLMContentPart,
  LLMRequest,
  LLMResponse,
  LLMStream,
  LLMToolSpec,
  LLMUsage,
} from "./types"

export interface VercelAILLMClientOptions {
  apiKey: string
  baseUrl?: string
  /** Max retries for transient failures (429, 5xx). Default 2. */
  maxRetries?: number
}

const DEFAULT_MAX_RETRIES = 2

function isRetryable(err: unknown): boolean {
  const msg = (err as { message?: string }).message ?? ""
  const status = (err as { statusCode?: number }).statusCode
  if (status === 429) return true
  if (status && status >= 500) return true
  return /rate.?limit|too.?many|timeout|overloaded|service.?unavailable/i.test(msg)
}

function backoffDelay(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 16_000)
  // Jitter: ±25%
  return base + base * 0.25 * (Math.random() * 2 - 1)
}

export class VercelAILLMClient implements LLMClient {
  private readonly openai
  private readonly maxRetries: number

  constructor(opts: VercelAILLMClientOptions) {
    this.openai = createOpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
    })
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this._complete(req)
      } catch (err) {
        lastErr = err
        if (attempt < this.maxRetries && isRetryable(err)) {
          const ms = backoffDelay(attempt)
          await new Promise((r) => setTimeout(r, ms))
          continue
        }
        throw err
      }
    }
    throw lastErr
  }

  async completeStream(req: LLMRequest): Promise<LLMStream> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this._completeStream(req)
      } catch (err) {
        lastErr = err
        if (attempt < this.maxRetries && isRetryable(err)) {
          const ms = backoffDelay(attempt)
          await new Promise((r) => setTimeout(r, ms))
          continue
        }
        throw err
      }
    }
    throw lastErr
  }

  private async _complete(req: LLMRequest): Promise<LLMResponse> {
    const model = this.openai(req.model)
    const tools = req.tools && req.tools.length > 0 ? this.toVercelTools(req.tools) : undefined
    const messages = this.convertMessages(req.messages)

    const result = await generateText({
      model,
      system: req.system,
      messages: messages as Parameters<typeof generateText>[0]["messages"],
      tools,
      toolChoice: tools ? "auto" : undefined,
    })

    const usage: LLMUsage = {
      promptTokens: result.usage?.promptTokens ?? 0,
      completionTokens: result.usage?.completionTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
    }

    if (result.toolCalls && result.toolCalls.length > 0) {
      return {
        kind: "tool_calls",
        calls: result.toolCalls.map((tc) => ({
          id: tc.toolCallId,
          name: tc.toolName,
          input: tc.args,
        })),
        usage,
      }
    }

    return { kind: "text", text: result.text, usage }
  }

  private async _completeStream(req: LLMRequest): Promise<LLMStream> {
    const model = this.openai(req.model)
    const tools = req.tools && req.tools.length > 0 ? this.toVercelTools(req.tools) : undefined
    const messages = this.convertMessages(req.messages)
    const result = streamText({
      model,
      system: req.system,
      messages: messages as Parameters<typeof streamText>[0]["messages"],
      tools,
      toolChoice: tools ? "auto" : undefined,
    })

    // eslint-disable-next-line require-yield
    return (async function* () {
      try {
        for await (const chunk of result.fullStream) {
          if (chunk.type === "text-delta") {
            yield { kind: "text_delta" as const, text: chunk.textDelta }
          } else if (chunk.type === "tool-call") {
            yield {
              kind: "tool_call_delta" as const,
              id: chunk.toolCallId,
              name: chunk.toolName,
              input: chunk.args,
            }
          } else if (chunk.type === "finish") {
            const usage: LLMUsage = {
              promptTokens: chunk.usage?.promptTokens ?? 0,
              completionTokens: chunk.usage?.completionTokens ?? 0,
              totalTokens: chunk.usage?.totalTokens ?? 0,
            }
            yield {
              kind: "done" as const,
              usage,
              finishReason: chunk.finishReason,
            }
          }
        }
      } catch (err) {
        yield { kind: "error" as const, message: (err as Error).message }
      }
    })()
  }

  /** Convert Butterfly LLMMessage[] to Vercel-compatible message format. */
  private convertMessages(
    messages: LLMRequest["messages"],
  ): Array<{ role: string; content: string | Array<{ type: string; text?: string; image?: string | Uint8Array; mimeType?: string }> }> {
    return messages.map((m) => {
      if (m.role === "tool") {
        if (!m.toolCallId) {
          throw new Error("VercelAILLMClient: tool message missing toolCallId")
        }
        return {
          role: "user" as const,
          content: `[Tool result for ${m.toolCallId}]: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
        }
      }
      // Handle multimodal content (array of parts).
      if (Array.isArray(m.content)) {
        return {
          role: m.role,
          content: m.content.map((part: LLMContentPart) => {
            if (part.type === "image") {
              // Convert base64 data-URI to Vercel SDK image part format.
              const dataUri = `data:${part.mimeType};base64,${part.data}`
              return { type: "image" as const, image: dataUri }
            }
            return { type: "text" as const, text: part.text }
          }),
        }
      }
      return { role: m.role, content: m.content }
    })
  }

  private toVercelTools(
    specs: LLMToolSpec[],
  ): Record<string, { description: string; parameters: ReturnType<typeof jsonSchema> }> {
    const out: Record<string, { description: string; parameters: ReturnType<typeof jsonSchema> }> =
      {}
    for (const spec of specs) {
      out[spec.name] = {
        description: spec.description,
        parameters: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
      }
    }
    return out
  }
}
