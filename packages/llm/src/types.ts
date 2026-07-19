// Public wire-level types for LLMClient. Pure types; no runtime code.

export type LLMRole = "user" | "assistant" | "tool" | "system"

/** Content part for multimodal messages (image support). */
export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string } // base64-encoded image data

/**
 * LLMMessage content can be either a plain string or an array of content parts.
 * Plain string is the common case; array enables multimodal (text + image) messages.
 */
export interface LLMMessage {
  role: LLMRole
  content: string | LLMContentPart[]
  toolCallId?: string // REQUIRED when role === "tool"; runtime-enforced.
}

export interface LLMToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown> // JSON Schema
}

export interface LLMUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
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
  | { kind: "tool_call_delta"; id: string; name?: string; input?: unknown }
  | { kind: "done"; usage: LLMUsage; finishReason: string }
  | { kind: "error"; message: string }

/** Async iterable stream of LLM response events. */
export type LLMStream = AsyncIterable<LLMStreamEvent>

export interface LLMClient {
  complete(req: LLMRequest): Promise<LLMResponse>
  /** Optional streaming completion. Returns an async iterable of events. */
  completeStream?(req: LLMRequest): Promise<LLMStream>
}
