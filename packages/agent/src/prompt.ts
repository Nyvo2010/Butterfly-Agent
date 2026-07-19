import type { ContextSlice } from "@butterfly/context"
import type { Mode } from "@butterfly/session"
import type { Tool } from "@butterfly/tools"
import { modePolicyText } from "./modes"

export interface PromptInput {
  mode: Mode
  query: string
  sceSlice: ContextSlice
  tools: Tool[]
}

export interface BuiltPrompt {
  system: string
  toolList: string
  codeContext: string
  grepMatches: string
}

/**
 * Build the system prompt for one Agent Loop iteration per MVP-SCOPE §10.
 * Composition: mode policy + tool descriptions + user query + SCE slice.
 */
export function buildSystemPrompt(input: PromptInput): BuiltPrompt {
  const toolList =
    input.tools.length === 0
      ? "(no tools available in this mode)"
      : input.tools.map((t) => `  - ${t.name} [${t.kind}]: ${t.description}`).join("\n")

  const grepMatches =
    input.sceSlice.grepMatches.length === 0
      ? "(none)"
      : input.sceSlice.grepMatches.map((m) => `  ${m.file}:${m.line}: ${m.content}`).join("\n")

  const codeContext =
    input.sceSlice.fileSnippets.length === 0
      ? "(no file snippets)"
      : input.sceSlice.fileSnippets
          .map((f) => `--- ${f.path} (${f.tokens} tokens) ---\n${f.content}`)
          .join("\n\n")

  const system = [
    `You are a Butterfly Agent in ${input.mode.toUpperCase()} mode.`,
    "",
    `MODE POLICY: ${modePolicyText(input.mode)}`,
    "",
    "INSTRUCTIONS:",
    "- You have access to tools. Use them to complete the user's request.",
    "- After using tools and verifying the result, respond with a final text message (no tool calls) summarizing what you did.",
    "- Do NOT call the same tool with the same arguments more than once — if a tool fails, try a different approach or report the error.",
    "- Be concise. Complete the task in as few steps as possible.",
    "",
    "AVAILABLE TOOLS:",
    toolList,
    "",
    "USER QUERY:",
    input.query,
    "",
    `GREP MATCHES (max ${input.sceSlice.grepMatches.length}):`,
    grepMatches,
    "",
    `CODE CONTEXT (max ${input.sceSlice.fileSnippets.length} snippets):`,
    codeContext,
  ].join("\n")

  return { system, toolList, codeContext, grepMatches }
}
