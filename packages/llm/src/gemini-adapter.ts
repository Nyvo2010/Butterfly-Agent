/**
 * Google Gemini-native LLM client adapter.
 * Uses the Gemini API directly for Google AI access.
 * Implements the LLMClient interface for seamless integration with the agent loop.
 */

import type { LLMClient, LLMRequest, LLMResponse, LLMStream } from "./types"

export interface GeminiClientOptions {
  apiKey: string
  /** Gemini model ID (e.g., "gemini-2.5-pro"). */
  model?: string
  /** Max retries for transient failures. Default 2. */
  maxRetries?: number
}

export class GeminiClient implements LLMClient {
  private readonly apiKey: string
  private readonly model: string
  private readonly maxRetries: number

  constructor(opts: GeminiClientOptions) {
    if (!opts.apiKey) throw new Error("GeminiClient: apiKey is required")
    this.apiKey = opts.apiKey
    this.model = opts.model ?? "gemini-2.5-pro"
    this.maxRetries = opts.maxRetries ?? 2
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = req.model || this.model
    const systemPrompt = req.system ?? ""

    // Gemini does not support a native "system" role in the contents array.
    // Embed system instructions as the first user message per Gemini docs.
    const systemParts = systemPrompt
      ? [{ role: "user" as const, parts: [{ text: `[System] ${systemPrompt}` }] }]
      : []

    const messages = req.messages.map((m) => {
      const role = m.role === "assistant" ? ("model" as const) : ("user" as const)
      return {
        role,
        parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
      }
    })

    // Combine system prompt with messages (system first, then user/model interleaved).
    const allMessages = [...systemParts, ...messages]

    // Merge consecutive same-role messages (Gemini API requirement).
    const merged: Array<{ role: string; parts: Array<{ text: string }> }> = []
    for (const msg of allMessages) {
      const last = merged[merged.length - 1]
      if (last && last.role === msg.role) {
        last.parts.push(...msg.parts)
      } else {
        merged.push(msg)
      }
    }

    const tools = req.tools?.map((t) => ({
      functionDeclarations: [
        {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      ],
    }))

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: merged,
            tools: tools?.length ? tools : undefined,
            generationConfig:
              req.temperature !== undefined
                ? { temperature: req.temperature, maxOutputTokens: 4096 }
                : { maxOutputTokens: 4096 },
          }),
        })

        if (!response.ok) {
          const errText = await response.text()
          if (response.status === 429 || response.status >= 500) {
            if (attempt < this.maxRetries) {
              await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
              continue
            }
          }
          // Non-retryable errors: throw immediately.
          throw new Error(`Gemini API error ${response.status}: ${errText}`)
        }

        const data = (await response.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                text?: string
                functionCall?: { name: string; args: unknown }
              }>
            }
          }>
          usageMetadata?: {
            promptTokenCount: number
            candidatesTokenCount: number
            totalTokenCount: number
          }
        }

        const candidate = data.candidates?.[0]
        if (!candidate?.content?.parts?.length) {
          return {
            kind: "text",
            text: "",
            usage: {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              usageAvailable: false,
            },
          }
        }

        // Check for function calls
        const functionCalls = candidate.content.parts.filter((p) => p.functionCall)
        if (functionCalls.length > 0) {
          return {
            kind: "tool_calls",
            calls: functionCalls.map((fc, i) => ({
              id: `tc-${Date.now()}-${i}`,
              name: fc.functionCall?.name ?? "unknown",
              input: fc.functionCall?.args ?? {},
            })),
            usage: {
              promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
              completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
              totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
              usageAvailable: !!data.usageMetadata,
            },
          }
        }

        const text = candidate.content.parts.map((p) => p.text ?? "").join("")

        return {
          kind: "text",
          text,
          usage: {
            promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
            completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
            totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
            usageAvailable: !!data.usageMetadata,
          },
        }
      } catch (err) {
        if (attempt >= this.maxRetries) throw err
      }
    }

    throw new Error("GeminiClient: max retries exceeded")
  }

  async completeStream(req: LLMRequest): Promise<LLMStream> {
    // Capture values before the generator to avoid `this` binding issues.
    const apiKey = this.apiKey
    const model = req.model || this.model
    const systemPrompt: string = req.system ?? ""
    // Gemini does not support a native "system" role in the contents array.
    // Embed system instructions as the first user message per Gemini docs.
    const systemParts = systemPrompt
      ? [{ role: "user" as const, parts: [{ text: `[System] ${systemPrompt}` }] }]
      : []
    const messages = req.messages.map((m) => {
      const role = m.role === "assistant" ? ("model" as const) : ("user" as const)
      return {
        role,
        parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
      }
    })

    // Merge consecutive same-role messages (Gemini requirement).
    const allMessages = [...systemParts, ...messages]
    const merged: typeof allMessages = []
    for (const msg of allMessages) {
      const last = merged[merged.length - 1]
      if (last && last.role === msg.role) {
        last.parts.push(...msg.parts)
      } else {
        merged.push(msg)
      }
    }

    const tools = req.tools?.map((t) => ({
      functionDeclarations: [
        {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      ],
    }))

    // eslint-disable-next-line require-yield
    return (async function* () {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: merged,
            tools: tools?.length ? tools : undefined,
            generationConfig:
              req.temperature !== undefined
                ? { temperature: req.temperature, maxOutputTokens: 4096 }
                : { maxOutputTokens: 4096 },
          }),
        })

        if (!response.ok) {
          yield { kind: "error" as const, message: `Gemini API error ${response.status}` }
          return
        }

        const reader = response.body?.getReader()
        if (!reader) {
          yield { kind: "error" as const, message: "No response body" }
          return
        }

        // Parse SSE stream with tool call support.
        const decoder = new TextDecoder()
        let buffer = ""
        let promptTokens = 0
        let completionTokens = 0
        const functionCalls = new Map<number, { name: string; args: unknown }>()

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            const data = line.slice(6).trim()
            try {
              const event = JSON.parse(data) as {
                candidates?: Array<{
                  content?: {
                    parts?: Array<{
                      text?: string
                      functionCall?: { name: string; args: unknown }
                    }>
                  }
                }>
                usageMetadata?: {
                  promptTokenCount: number
                  candidatesTokenCount: number
                  totalTokenCount: number
                }
              }

              // Extract text deltas.
              const parts = event.candidates?.[0]?.content?.parts
              if (parts) {
                for (let i = 0; i < parts.length; i++) {
                  const part = parts[i]
                  if (part?.text) {
                    yield { kind: "text_delta" as const, text: part.text }
                  }
                  if (part?.functionCall) {
                    functionCalls.set(i, {
                      name: part.functionCall.name,
                      args: part.functionCall.args,
                    })
                  }
                }
              }

              // Capture usage metadata from the last event.
              if (event.usageMetadata) {
                promptTokens = event.usageMetadata.promptTokenCount
                completionTokens = event.usageMetadata.candidatesTokenCount
              }
            } catch {
              // Skip unparseable events.
            }
          }
        }

        // Emit tool calls after stream completes (Gemini sends full functionCall objects).
        let tcIdx = 0
        for (const [, fc] of functionCalls) {
          yield {
            kind: "tool_call_delta" as const,
            id: `tc-gemini-${tcIdx++}-${Date.now()}`,
            name: fc.name,
            input: fc.args,
          }
        }

        yield {
          kind: "done" as const,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            usageAvailable: promptTokens + completionTokens > 0,
          },
          finishReason: "stop",
        }
      } catch (err) {
        yield {
          kind: "error" as const,
          message: `GeminiClient stream error: ${(err as Error).message}`,
        }
      }
    })()
  }
}
