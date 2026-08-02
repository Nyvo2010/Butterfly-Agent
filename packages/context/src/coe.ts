import { log } from "@butterfly/core"
import type { SessionState, ToolCallRecord } from "@butterfly/session"
import type { COEOptions, Tokenizer } from "./types"

const DEFAULT_TOOL_MESSAGE_MAX_TOKENS = 2000
const COMPRESSOR_BUDGET_SLACK = 500

/**
 * Context Optimization Engine (COE).
 * Reduces session token usage by deduplicating tool calls, truncating tool
 * messages, running optional semantic compression, and dropping oldest
 * non-preserved messages to fit within the context budget.
 */
export class COE {
  constructor(private readonly tokenizer: Tokenizer) {}

  /**
   * Optimize a session state to fit within `maxContextTokens`.
   * Always preserves the system message (if present) and the last 2 messages.
   * Returns warnings if the budget cannot be met after all optimization passes.
   */
  async optimize(
    state: SessionState,
    options: COEOptions,
  ): Promise<SessionState & { warnings: string[] }> {
    if (!Number.isFinite(options.maxContextTokens) || options.maxContextTokens <= 0) {
      throw new Error(`COE: invalid maxContextTokens: ${options.maxContextTokens}`)
    }

    const warnings: string[] = []

    // Deep clone mutable arrays to avoid mutating the caller's state.
    // fileChanges and readFiles are not modified during optimization, pass through directly.
    const next: SessionState = {
      ...state,
      messages: state.messages.map((m) => ({ ...m })),
      toolCalls: state.toolCalls.map((tc) => ({ ...tc })),
      fileChanges: state.fileChanges,
      readFiles: state.readFiles,
    }

    // 1. Dedupe ToolCallRecord by id — keep the latest occurrence only.
    const seen = new Map<string, ToolCallRecord>()
    for (const tc of next.toolCalls) seen.set(tc.id, tc)
    next.toolCalls = Array.from(seen.values())

    // 2. Truncate long tool-role messages + build token count array for passes 3-4.
    const toolMax = options.toolMessageMaxTokens ?? DEFAULT_TOOL_MESSAGE_MAX_TOKENS
    const counts: number[] = []
    for (let i = 0; i < next.messages.length; i++) {
      const m = next.messages[i]
      if (m.role === "tool") {
        let tokens: number
        try {
          tokens = this.tokenizer.count(m.content)
        } catch {
          tokens = m.content.length
        }
        if (tokens > toolMax) {
          try {
            const { text, tokens: actualTokens } = this.tokenizer.truncate(m.content, toolMax)
            next.messages[i] = { ...m, content: text }
            counts.push(actualTokens)
          } catch {
            next.messages[i] = { ...m, content: m.content.slice(0, toolMax * 4) }
            counts.push(toolMax)
          }
          continue
        }
        counts.push(tokens)
        continue
      }
      try {
        counts.push(this.tokenizer.count(m.content))
      } catch {
        counts.push(m.content.length)
      }
    }

    let total = counts.reduce((a, b) => a + b, 0)

    // Compute preserved message budget for compression pass.
    const preserveHead = next.messages[0]?.role === "system" ? 1 : 0
    let preserveTail = Math.min(2, next.messages.length - preserveHead)
    let preservedEnd = next.messages.length - preserveTail

    // 3. Semantic compression: if a compressor is configured and we're still over
    //    budget, compress oldest non-system messages instead of dropping them.
    if (options.compressor && total > options.maxContextTokens) {
      const compressEnd = Math.max(preserveHead, preservedEnd)
      if (compressEnd > preserveHead) {
        const toCompress = next.messages.slice(preserveHead, compressEnd)
        const budget = total - options.maxContextTokens + COMPRESSOR_BUDGET_SLACK
        try {
          const compressed = await options.compressor(toCompress, budget)
          if (compressed.length === 0) {
            log("warn", "coe.compressor_empty")
          } else {
            const allValid = compressed.every(
              (m) => typeof m.content === "string" && typeof m.role === "string",
            )
            if (!allValid) {
              log("warn", "coe.compressor_invalid_messages")
            } else {
              const compressedCounts = await Promise.all(
                compressed.map((m) => {
                  try {
                    return this.tokenizer.count(m.content)
                  } catch {
                    return m.content.length
                  }
                }),
              )
              next.messages.splice(preserveHead, toCompress.length, ...compressed)
              counts.splice(preserveHead, toCompress.length, ...compressedCounts)
              total = counts.reduce((a, b) => a + b, 0)
              // Recalculate preserveTail after compression (message count may differ).
              preserveTail = Math.min(2, next.messages.length - preserveHead)
              preservedEnd = next.messages.length - preserveTail
            }
          }
        } catch (err) {
          log("error", "coe.compressor_failed", { error: (err as Error).message })
        }
      }
    }

    // 4. Drop oldest droppable message groups until total token count is under cap.
    // Each "group" is an assistant "Using tools:" message followed by its tool result
    // messages. Dropping individual messages would corrupt tool-call pairings and
    // cause LLM API validation errors. We drop complete groups only.
    while (total > options.maxContextTokens && next.messages.length > preserveHead + preserveTail) {
      const dropIdx = next.messages[0]?.role === "system" ? 1 : 0
      if (next.messages.length <= dropIdx + preserveTail) break

      const group = findMessageGroup(next.messages, dropIdx)
      const deleted = next.messages.splice(group.start, group.count)
      const deletedTokens = counts.splice(group.start, group.count).reduce((a, b) => a + b, 0)
      total -= deletedTokens

      log("debug", "coe.drop_group", {
        dropped: deleted.length,
        tokens: deletedTokens,
        remaining: next.messages.length,
        total,
      })
    }

    // 5. Warn if still over budget after all optimization passes.
    if (total > options.maxContextTokens) {
      warnings.push(
        `Token budget exceeded after optimization: ${total} > ${options.maxContextTokens}`,
      )
    }

    return { ...next, warnings }
  }
}

/**
 * Given an index into messages, find the complete group it belongs to.
 * A group is: an assistant tool-call message + all subsequent tool-role
 * messages belonging to it. This ensures we never drop half a tool-call
 * interaction, which would cause LLM API validation errors from orphaned
 * tool results or missing tool calls.
 *
 * Group markers are detected structurally (in priority order):
 *   1. `parts` containing a `tool_call` entry (OpenCode-style message parts)
 *   2. assistant message with a `toolCallId` (Butterfly's loop sets this)
 *   3. legacy "Using tools:" string prefix (backward compat)
 */
function findMessageGroup(
  messages: Array<{
    role: string
    content: string
    toolCallId?: string
    parts?: Array<{ type: string }>
  }>,
  idx: number,
): { start: number; count: number } {
  const msg = messages[idx]
  if (!msg) return { start: idx, count: 0 }

  const isAssistantGroupMarker = (m: {
    role: string
    content: string
    toolCallId?: string
    parts?: Array<{ type: string }>
  }): boolean => {
    if (m.role !== "assistant") return false
    // Structural detection — parts with tool_call entries are authoritative.
    if (m.parts?.some((p) => p.type === "tool_call")) return true
    if (m.toolCallId) return true
    return m.content.startsWith("Using tools:")
  }

  if (msg.role === "tool") {
    // This is a tool result. Walk backward to find its parent assistant
    // group marker by toolCallId or structure.
    let start = idx
    while (start > 0) {
      const prev = messages[start - 1]
      if (prev.role === "tool") {
        start--
        continue
      }
      if (isAssistantGroupMarker(prev)) {
        start = start - 1
        break
      }
      break
    }
    // Count forward: include this tool + any following tool messages.
    let count = idx - start + 1
    for (let i = idx + 1; i < messages.length; i++) {
      if (messages[i].role === "tool") count++
      else break
    }
    return { start, count }
  }

  if (isAssistantGroupMarker(msg)) {
    let count = 1
    for (let i = idx + 1; i < messages.length; i++) {
      if (messages[i].role === "tool") count++
      else break
    }
    return { start: idx, count }
  }

  // Regular user/assistant/system message — drop individually.
  return { start: idx, count: 1 }
}
