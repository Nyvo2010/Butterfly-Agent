/**
 * Anthropic-native LLM client adapter.
 * Uses the Anthropic Messages API directly via fetch.
 * Implements the LLMClient interface for seamless integration with the agent loop.
 */

import { bareModelId } from "./client"
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStream,
  LLMUsage,
  ModelRequestOverrideMap,
} from "./types"

export interface AnthropicClientOptions {
  apiKey: string
  /** Anthropic model ID (e.g., "claude-sonnet-4-20250514"). */
  model?: string
  /** Max retries for transient failures. Default 2. */
  maxRetries?: number
  /**
   * Provider-level options merged into the request body
   * (e.g. { reasoning: { effort: "high" } } — mirrors OpenCode provider options).
   */
  options?: Record<string, unknown>
  /** Per-model request overrides (headers/body) keyed by bare model id. */
  modelOverrides?: ModelRequestOverrideMap
}

export class AnthropicClient implements LLMClient {
  private readonly apiKey: string
  private readonly model: string
  private readonly maxRetries: number
  private readonly options: Record<string, unknown>
  private readonly modelOverrides: ModelRequestOverrideMap

  constructor(opts: AnthropicClientOptions) {
    if (!opts.apiKey) throw new Error("AnthropicClient: apiKey is required")
    this.apiKey = opts.apiKey
    this.model = opts.model ?? "claude-sonnet-4-20250514"
    this.maxRetries = opts.maxRetries ?? 2
    this.options = opts.options ?? {}
    this.modelOverrides = opts.modelOverrides ?? {}
  }

  /** Merge provider options + per-model overrides + request extras for a model. */
  private mergedBody(
    req: LLMRequest,
    model: string,
    base: Record<string, unknown>,
  ): Record<string, unknown> {
    const override = this.modelOverrides[model]
    return {
      ...base,
      ...this.options,
      ...(req.options ?? {}),
      ...(req.requestBody ?? {}),
      ...(override?.body ?? {}),
    }
  }

  /** Merge per-model + request headers. */
  private mergedHeaders(
    req: LLMRequest,
    model: string,
    base: Record<string, string>,
  ): Record<string, string> {
    const override = this.modelOverrides[model]
    return {
      ...base,
      ...(override?.headers ?? {}),
      ...(req.requestHeaders ?? {}),
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // Honor the per-request model so a cached client (ProviderService caches by
    // provider prefix) doesn't pin the first model used. Strip any provider
    // prefix — the API expects a bare model id.
    const model = bareModelId(req.model || this.model)

    // Filter system messages from the array — Anthropic uses a top-level system param.
    // Combine any system messages from the session with the caller-provided system prompt.
    const systemMessages = req.messages.filter((m) => m.role === "system")
    const conversationMessages = req.messages.filter((m) => m.role !== "system")

    let systemPrompt = req.system || ""
    for (const sm of systemMessages) {
      const content = typeof sm.content === "string" ? sm.content : JSON.stringify(sm.content)
      if (systemPrompt) systemPrompt += `\n\n${content}`
      else systemPrompt = content
    }

    const messages = conversationMessages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }))

    const tools = req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Record<string, unknown>,
    }))

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const body = this.mergedBody(req, model, {
          model,
          system: systemPrompt || undefined,
          messages,
          tools: tools?.length ? tools : undefined,
          max_tokens: 4096,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        })
        const headers = this.mergedHeaders(req, model, {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        })
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          const errText = await response.text()
          if (response.status === 429 || response.status >= 500) {
            if (attempt < this.maxRetries) {
              await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
              continue
            }
          }
          // Non-retryable errors: throw immediately.
          throw new Error(`Anthropic API error ${response.status}: ${errText}`)
        }

        const data = (await response.json()) as {
          content: Array<{ type: string; text?: string }>
          stop_reason: string
          usage: { input_tokens: number; output_tokens: number }
        }

        const textBlocks = data.content.filter((c) => c.type === "text")
        const text = textBlocks.map((c) => c.text ?? "").join("")

        // Check for tool use blocks
        const toolBlocks = data.content.filter((c) => c.type === "tool_use")
        if (toolBlocks.length > 0) {
          return {
            kind: "tool_calls",
            calls: toolBlocks.map((tb, i) => ({
              id: `tc-${Date.now()}-${i}`,
              name: (tb as { name?: string }).name ?? "unknown",
              input: (tb as { input?: unknown }).input ?? {},
            })),
            usage: {
              promptTokens: data.usage?.input_tokens ?? 0,
              completionTokens: data.usage?.output_tokens ?? 0,
              totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
              usageAvailable: !!data.usage,
            },
          }
        }

        const usage: LLMUsage = {
          promptTokens: data.usage?.input_tokens ?? 0,
          completionTokens: data.usage?.output_tokens ?? 0,
          totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
          usageAvailable: !!data.usage,
        }

        return { kind: "text", text, usage }
      } catch (err) {
        if (attempt >= this.maxRetries) throw err
      }
    }

    throw new Error("AnthropicClient: max retries exceeded")
  }

  async completeStream(req: LLMRequest): Promise<LLMStream> {
    // Capture values before the generator to avoid `this` binding issues.
    // Honor per-request model (see complete() — cached clients must not pin).
    const apiKey = this.apiKey
    const model = bareModelId(req.model || this.model)

    // Filter system messages from the array — Anthropic uses a top-level system param.
    const systemMessages = req.messages.filter((m) => m.role === "system")
    const conversationMessages = req.messages.filter((m) => m.role !== "system")

    let systemPrompt = req.system || ""
    for (const sm of systemMessages) {
      const content = typeof sm.content === "string" ? sm.content : JSON.stringify(sm.content)
      if (systemPrompt) systemPrompt += `\n\n${content}`
      else systemPrompt = content
    }

    const messages = conversationMessages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }))

    const tools = req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Record<string, unknown>,
    }))

    // Capture provider options for the generator (mirrors complete()).
    const options = this.options
    const modelOverrides = this.modelOverrides

    // eslint-disable-next-line require-yield
    return (async function* () {
      try {
        const override = modelOverrides[model]
        const body = {
          model: model,
          system: systemPrompt || undefined,
          messages,
          tools: tools?.length ? tools : undefined,
          max_tokens: 4096,
          stream: true,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...options,
          ...(req.options ?? {}),
          ...(req.requestBody ?? {}),
          ...(override?.body ?? {}),
        }
        const headers = {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          ...(override?.headers ?? {}),
          ...(req.requestHeaders ?? {}),
        }
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          yield { kind: "error" as const, message: `Anthropic API error ${response.status}` }
          return
        }

        const reader = response.body?.getReader()
        if (!reader) {
          yield { kind: "error" as const, message: "No response body" }
          return
        }

        const decoder = new TextDecoder()
        let buffer = ""
        let promptTokens = 0
        let completionTokens = 0
        const toolUseBlocks = new Map<number, { id: string; name: string; json: string }>()

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            const data = line.slice(6).trim()
            if (data === "[DONE]") continue

            try {
              const event = JSON.parse(data) as {
                type: string
                index?: number
                content_block?: { type: string; id?: string; name?: string }
                delta?: { type: string; text?: string; partial_json?: string }
                usage?: { input_tokens?: number; output_tokens?: number }
              }

              if (
                event.type === "content_block_start" &&
                event.content_block?.type === "tool_use"
              ) {
                // Track that a tool use block started for this index.
                const idx = event.index ?? 0
                toolUseBlocks.set(idx, {
                  id: event.content_block.id ?? `tc-${idx}`,
                  name: event.content_block.name ?? "unknown",
                  json: "",
                })
              } else if (event.type === "content_block_delta") {
                if (event.delta?.type === "text_delta") {
                  yield {
                    kind: "text_delta" as const,
                    text: event.delta.text ?? "",
                  }
                } else if (event.delta?.type === "input_json_delta" && event.delta?.partial_json) {
                  const idx = event.index ?? 0
                  const block = toolUseBlocks.get(idx)
                  if (block) {
                    block.json += event.delta.partial_json
                  }
                }
              } else if (event.type === "content_block_stop") {
                const idx = event.index ?? 0
                const block = toolUseBlocks.get(idx)
                if (block?.json) {
                  try {
                    const input = JSON.parse(block.json)
                    yield {
                      kind: "tool_call_delta" as const,
                      id: block.id,
                      name: block.name,
                      input,
                    }
                  } catch {
                    // Incomplete JSON — skip this tool call.
                  }
                }
              } else if (event.type === "message_stop") {
                if (event.usage) {
                  promptTokens = event.usage.input_tokens ?? 0
                  completionTokens = event.usage.output_tokens ?? 0
                }
              }
            } catch {
              // Skip unparseable events.
            }
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
          message: `AnthropicClient stream error: ${(err as Error).message}`,
        }
      }
    })()
  }
}
