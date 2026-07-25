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
  const status = (err as { status?: number }).status
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
    if (!opts.apiKey || typeof opts.apiKey !== "string") {
      throw new Error("VercelAILLMClient: apiKey must be a non-empty string")
    }
    this.openai = createOpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
    })
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (!req.model || typeof req.model !== "string") {
      throw new Error("VercelAILLMClient: req.model must be a non-empty string")
    }
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
    // Retry logic for streaming is handled inside _completeStream because
    // the streamText() call returns synchronously (Vercel AI SDK v4) and
    // errors surface lazily during iteration, not during the initial call.
    // The outer retry wrapper would never catch stream errors.
    return this._completeStream(req, this.maxRetries)
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

    const hasUsage = !!result.usage
    const usage: LLMUsage = {
      promptTokens: result.usage?.promptTokens ?? 0,
      completionTokens: result.usage?.completionTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
      usageAvailable: hasUsage,
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

  private async _completeStream(req: LLMRequest, retriesRemaining: number = 0): Promise<LLMStream> {
    // eslint-disable-next-line require-yield
    return (async function* (adapter: VercelAILLMClient) {
      let attempt = 0
      const yieldedToolCallIds = new Set<string>()
      let yieldedChunks = false
      while (attempt <= retriesRemaining) {
        const model = adapter.openai(req.model)
        const tools =
          req.tools && req.tools.length > 0 ? adapter.toVercelTools(req.tools) : undefined
        const messages = adapter.convertMessages(req.messages)
        try {
          const result = streamText({
            model,
            system: req.system,
            messages: messages as Parameters<typeof streamText>[0]["messages"],
            tools,
            toolChoice: tools ? "auto" : undefined,
          })
          for await (const chunk of result.fullStream) {
            if (chunk.type === "text-delta") {
              yieldedChunks = true
              yield { kind: "text_delta" as const, text: chunk.textDelta }
            } else if (chunk.type === "tool-call") {
              yieldedChunks = true
              if (!yieldedToolCallIds.has(chunk.toolCallId)) {
                yieldedToolCallIds.add(chunk.toolCallId)
                yield {
                  kind: "tool_call_delta" as const,
                  id: chunk.toolCallId,
                  name: chunk.toolName,
                  input: chunk.args,
                }
              }
            } else if (chunk.type === "finish") {
              const hasUsage = !!chunk.usage
              const usage: LLMUsage = {
                promptTokens: chunk.usage?.promptTokens ?? 0,
                completionTokens: chunk.usage?.completionTokens ?? 0,
                totalTokens: chunk.usage?.totalTokens ?? 0,
                usageAvailable: hasUsage,
              }
              yield {
                kind: "done" as const,
                usage,
                finishReason: chunk.finishReason,
              }
            }
          }
          break
        } catch (err) {
          attempt++
          // Only retry if no chunks have been yielded yet. Once the caller
          // has started receiving deltas, retrying would produce duplicate
          // text that corrupts the accumulated output.
          if (yieldedChunks || attempt > retriesRemaining || !isRetryable(err)) {
            yield { kind: "error" as const, message: (err as Error).message }
            break
          }
          const ms = backoffDelay(attempt - 1)
          await new Promise((r) => setTimeout(r, ms))
        }
      }
    })(this)
  }

  /** Convert Butterfly LLMMessage[] to Vercel-compatible message format. */
  private convertMessages(messages: LLMRequest["messages"]): Array<{
    role: string
    content:
      | string
      | Array<{ type: string; text?: string; image?: string | Uint8Array; mimeType?: string }>
    toolCallId?: string
  }> {
    return messages.map((m) => {
      if (m.role === "tool") {
        if (!m.toolCallId) {
          throw new Error("VercelAILLMClient: tool message missing toolCallId")
        }
        // Vercel AI SDK v4 supports native tool role messages.
        // Use the proper role and pass the toolCallId for model correlation.
        return {
          role: "tool" as const,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          toolCallId: m.toolCallId,
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
      try {
        out[spec.name] = {
          description: spec.description,
          parameters: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
        }
      } catch (err) {
        throw new Error(
          `VercelAILLMClient: invalid inputSchema for tool "${spec.name}": ${(err as Error).message}`,
        )
      }
    }
    return out
  }
}
