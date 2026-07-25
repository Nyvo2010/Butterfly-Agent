// Public wire-level types for LLMClient. Pure types; no runtime code.

export type LLMImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "image/avif"

/** Content part for multimodal messages (image support). */
export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: LLMImageMimeType; data: string }

export interface LLMUserMessage {
  role: "user"
  content: string | LLMContentPart[]
}

export interface LLMAssistantMessage {
  role: "assistant"
  content: string | LLMContentPart[]
}

export interface LLMToolMessage {
  role: "tool"
  content: string | LLMContentPart[]
  toolCallId: string
}

export interface LLMSystemMessage {
  role: "system"
  content: string | LLMContentPart[]
}

export type LLMMessage = LLMUserMessage | LLMAssistantMessage | LLMToolMessage | LLMSystemMessage

export interface LLMToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown> // JSON Schema
}

export interface LLMUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** When false, the token counts are defaults (0) and not from the provider. */
  usageAvailable: boolean
}

export interface LLMRequest {
  model: string // concrete model id; tier mapping is packages/agent's job
  system: string
  messages: LLMMessage[]
  tools?: LLMToolSpec[]
}

export type LLMResponse =
  | { kind: "text"; text: string; usage: LLMUsage }
  | {
      kind: "tool_calls"
      calls: Array<{ id: string; name: string; input: unknown }>
      usage: LLMUsage
    }

export interface ToolCallParser {
  parse(raw: string): Array<{ id: string; name: string; input: unknown }> | null
}

/** Streaming delta emitted during a streamed completion. */
export type LLMStreamEvent =
  | { kind: "text_delta"; text: string }
  | {
      kind: "tool_call_delta"
      id: string
      name?: string
      /** Complete tool arguments at this point, not incremental deltas. */
      input?: unknown
    }
  | { kind: "done"; usage: LLMUsage; finishReason: string }
  | { kind: "error"; message: string }

/** Async iterable stream of LLM response events. */
export type LLMStream = AsyncIterable<LLMStreamEvent>

export interface LLMClient {
  complete(req: LLMRequest): Promise<LLMResponse>
  /** Optional streaming completion. Returns an async iterable of events. */
  completeStream?(req: LLMRequest): Promise<LLMStream>
}
