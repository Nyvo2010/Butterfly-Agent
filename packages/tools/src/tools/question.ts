import type { Tool } from "../types"

/**
 * OpenCode-compatible question/ask_user tool.
 * Pauses the agent loop to ask the user a question, returning the answer.
 * Requires `ctx.onAskUser` callback to be set by the CLI/server.
 *
 * Input schema: { question: string, options?: string[] }
 * Output: { answer: string }
 */
export const questionTool: Tool<{ answer: string }> = {
  name: "ask_user",
  description:
    "Ask the user a question and wait for their response. " +
    "Use this when you need clarification, want to confirm a decision, " +
    "or need the user to choose between options. " +
    "Provide an optional `options` array for multiple choice questions.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of valid choices for the user to pick from.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const question = String(input.question ?? "")
    if (!question) return { kind: "err", message: "question is required" }

    if (!ctx.onAskUser) {
      return {
        kind: "err",
        message: "User interaction is not available (no onAskUser callback configured).",
      }
    }

    const options = Array.isArray(input.options)
      ? (input.options as string[]).filter((o): o is string => typeof o === "string")
      : undefined

    try {
      const answer = await ctx.onAskUser(question, options, {
        tool: "ask_user",
        category: "ask_user",
      })
      if (answer === null) {
        return { kind: "err", message: "User cancelled the question." }
      }
      return { kind: "ok", output: { answer } }
    } catch (err) {
      return {
        kind: "err",
        message: `Failed to get user response: ${(err as Error).message}`,
      }
    }
  },
}
