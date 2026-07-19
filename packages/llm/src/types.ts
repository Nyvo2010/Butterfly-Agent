// Public wire-level types for LLMClient. Pure types; no runtime code.

export type LLMRole = "user" | "assistant" | "tool" | "system"

export interface LLMMessage {
  role: LLMRole
  content: string
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

export interface LLMClient {
  complete(req: LLMRequest): Promise<LLMResponse>
}
