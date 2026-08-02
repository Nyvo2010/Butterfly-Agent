/**
 * In-loop summarization compressor — SmallCode/Atomic-style context preservation.
 *
 * When the context budget is exceeded, instead of only dropping the oldest
 * message groups (COE's default), the compressor asks the LLM to condense the
 * oldest tool-call history into a single compact user message. This keeps the
 * durable facts of early work available for small context windows while
 * reclaiming the bulk of the tokens.
 *
 * Mirrors OpenCode's compaction (summarize old turns into a summary message)
 * and SmallCode's two-tier memory (short-term eviction with summary anchor).
 *
 * The compressor is wired into COE via the existing `compressor` hook — COE
 * already calls it when over budget and falls back to dropping if the
 * compressor returns nothing useful.
 */

import type { Compressor } from "@butterfly/context"
import { log } from "@butterfly/core"
import type { LLMClient } from "@butterfly/llm"
import type { SessionMessage } from "@butterfly/session"

export interface CompactorOptions {
  /** Resolve the LLM client for the summarization call (model-aware). */
  getLLM: () => LLMClient | undefined
  /** Resolve the model id for the summarization call. */
  getModel: () => string
  /** Never summarize fewer than this many messages. Default 4. */
  minMessages?: number
  /** Summaries are capped at this many characters. Default 3000. */
  maxSummaryChars?: number
}

/** Convert a message to a compact single-line for the summary prompt. */
function messageToLine(m: SessionMessage): string {
  const role = m.role
  const content = m.content.length > 500 ? `${m.content.slice(0, 500)}…` : m.content
  return `${role}: ${content.replace(/\n+/g, " ")}`
}

/**
 * Build a `Compressor` that summarizes the oldest messages with an LLM call.
 * Fails soft: on any error (or when no LLM is available), returns the input
 * unchanged so COE falls back to its drop-group behavior.
 */
export function createSummarizingCompressor(opts: CompactorOptions): Compressor {
  const minMessages = opts.minMessages ?? 4
  const maxSummaryChars = opts.maxSummaryChars ?? 3000

  return async (messages, _budget) => {
    // Keep the tail (latest messages + the final reply) intact — only compress
    // the older prefix. If there's nothing worth compressing, bail out.
    const tail = 3
    if (messages.length <= minMessages + tail) return messages
    const toCompress = messages.slice(0, messages.length - tail)
    const keepTail = messages.slice(messages.length - tail)

    const llm = opts.getLLM()
    if (!llm) return messages

    const transcript = toCompress.map(messageToLine).join("\n")
    const system =
      "You are a context-compression engine. Condense the following agent " +
      "conversation excerpt into a short factual summary. Preserve: what files " +
      "were read/changed, key findings, the user's goals, and any decisions or " +
      "constraints. Omit tool-call mechanics and obvious errors. Return ONLY " +
      "the summary text, no preamble."

    try {
      const response = await llm.complete({
        model: opts.getModel(),
        system,
        messages: [{ role: "user", content: transcript }],
      })
      if (response.kind !== "text") return messages
      const summary = response.text.trim()
      if (!summary) return messages
      const truncated =
        summary.length > maxSummaryChars ? `${summary.slice(0, maxSummaryChars)}…` : summary

      const summaryMessage: SessionMessage = {
        id: `msg-summary-${Date.now()}`,
        role: "user",
        content: `[Earlier context summary] ${truncated}`,
        parts: [{ type: "text", text: `[Earlier context summary] ${truncated}` }],
        timestamp: new Date().toISOString(),
      }
      log("info", "compactor.summarized", {
        compressedCount: toCompress.length,
        summaryChars: truncated.length,
      })
      return [summaryMessage, ...keepTail]
    } catch (err) {
      log("warn", "compactor.failed", { error: (err as Error).message })
      return messages
    }
  }
}
