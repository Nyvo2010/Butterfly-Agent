import { createOpenAI } from "@ai-sdk/openai"
import { generateText, jsonSchema } from "ai"
import type { LLMClient, LLMRequest, LLMResponse, LLMToolSpec, LLMUsage } from "./types"

export interface VercelAILLMClientOptions {
  apiKey: string
  baseUrl?: string
}

export class VercelAILLMClient implements LLMClient {
  private readonly openai

  constructor(opts: VercelAILLMClientOptions) {
    this.openai = createOpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
    })
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = this.openai(req.model)

    const tools = req.tools && req.tools.length > 0 ? this.toVercelTools(req.tools) : undefined

    const messages = req.messages.map((m) => {
      if (m.role === "tool") {
        if (!m.toolCallId) {
          throw new Error("VercelAILLMClient: tool message missing toolCallId")
        }
        // Vercel AI SDK v4 rejects role:"tool" whose content is a plain string —
        // its standardizePrompt requires content to be an Array<ToolResultPart>
        // with toolCallId/toolName/output fields. YAGNI fix: surface tool history
        // to the LLM as a user-role message with a clear [Tool result] prefix.
        // Functionally equivalent for the LLM, spec-clean for every provider.
        return {
          role: "user" as const,
          content: `[Tool result for ${m.toolCallId}]: ${m.content}`,
        }
      }
      return { role: m.role, content: m.content }
    })

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
