import type { ContextSlice } from "@butterfly/context"
import type { Mode } from "@butterfly/session"
import { modePolicyText } from "./modes"
import type { Plan } from "./planning"
import { formatPlanForPrompt } from "./planning"

/** Lightweight tool metadata for prompt building — avoids coupling to the full Tool type. */
export interface ToolMeta {
  name: string
  kind: string
  description: string
}

export interface PromptInput {
  mode: Mode
  query: string
  sceSlice: ContextSlice
  tools: ToolMeta[]
  /** Optional active plan for TODO-driven planning display. */
  plan?: Plan
  /**
   * Include the tool list in the system prompt.
   * Set to true when using a parser-based LLM that outputs tool calls
   * as text (Hermes, LiquidAI, XML formats) rather than natively via API.
   * Default false — native tool-calling models get tools via API.
   */
  includeToolList?: boolean
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
 * Bootstrap summary is injected into the first user message (not here) to
 * avoid wasting tokens on every iteration.
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

  const MAX_SNIPPET_CHARS = 4_000
  const codeContext =
    input.sceSlice.fileSnippets.length === 0
      ? "(no file snippets)"
      : input.sceSlice.fileSnippets
          .map(
            (f) =>
              `--- ${f.path} (${f.tokens} tokens) ---\n${f.content.slice(0, MAX_SNIPPET_CHARS)}`,
          )
          .join("\n\n")

  const planBlock = input.plan ? formatPlanForPrompt(input.plan) : ""

  const system = [
    `You are a Butterfly Agent in ${input.mode.toUpperCase()} mode.`,
    `MODE POLICY: ${modePolicyText(input.mode)}`,
    "",
    "INSTRUCTIONS:",
    "- You have access to tools. Use them to complete the user's request.",
    "- After using tools and verifying the result, respond with a final text message (no tool calls) summarizing what you did.",
    "- Do NOT call the same tool with the same arguments more than once — if a tool fails, try a different approach or report the error.",
    "- Be concise. Complete the task in as few steps as possible.",
    planBlock,
    "EDITING GUIDELINES:",
    "- Prefer patch/diff_patch over write when modifying existing files. Only use write for new files.",
    "- Before editing any file, read it first to understand its current contents.",
    "- Make surgical, minimal changes. Do not refactor unrelated code.",
    "- The diff_patch tool accepts unified diff format — use it for multi-line changes.",
    "- The patch tool accepts oldText/newText — use it for single-replacement edits.",
    "",
    ...(input.includeToolList ? ["AVAILABLE TOOLS:", toolList, ""] : []),
    "USER QUERY:",
    input.query,
    "",
    `GREP MATCHES (${input.sceSlice.grepMatches.length}):`,
    grepMatches,
    "",
    `CODE CONTEXT (${input.sceSlice.fileSnippets.length} snippets):`,
    codeContext,
  ].join("\n")

  return { system, toolList, codeContext, grepMatches }
}
