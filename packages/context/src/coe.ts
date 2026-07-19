import type { SessionState, ToolCallRecord } from "@butterfly/session"
import type { COEOptions, Tokenizer } from "./types"

const DEFAULT_TOOL_MESSAGE_MAX_TOKENS = 2000

export class COE {
  constructor(private readonly tokenizer: Tokenizer) {}

  optimize(state: SessionState, options: COEOptions): SessionState {
    // Instead of structuredClone, shallow-clone only the arrays we mutate.
    const next: SessionState = {
      ...state,
      messages: state.messages.map((m) => ({ ...m })),
      toolCalls: [...state.toolCalls],
    }

    // 1. Dedupe ToolCallRecord by id — keep the latest occurrence only.
    const seen = new Map<string, ToolCallRecord>()
    for (const tc of next.toolCalls) seen.set(tc.id, tc)
    next.toolCalls = Array.from(seen.values())

    // 2. Truncate long tool-role messages + build token count array for pass 3.
    const toolMax = options.toolMessageMaxTokens ?? DEFAULT_TOOL_MESSAGE_MAX_TOKENS
    const counts: number[] = []
    for (let i = 0; i < next.messages.length; i++) {
      const m = next.messages[i]
      if (m.role === "tool") {
        const tokens = this.tokenizer.count(m.content)
        if (tokens > toolMax) {
          const { text } = this.tokenizer.truncate(m.content, toolMax)
          next.messages[i] = { ...m, content: text }
          counts.push(this.tokenizer.count(text))
          continue
        }
        counts.push(tokens)
        continue
      }
      counts.push(this.tokenizer.count(m.content))
    }

    // 3. Drop oldest droppable messages until total token count is under cap.
    //    The first message is preserved if it is a system message.
    let total = counts.reduce((a, b) => a + b, 0)
    while (total > options.maxContextTokens && next.messages.length > 1) {
      const dropIdx = next.messages[0]?.role === "system" ? 1 : 0
      if (next.messages.length <= dropIdx + 1) break
      total -= counts[dropIdx]
      next.messages.splice(dropIdx, 1)
      counts.splice(dropIdx, 1)
    }

    return next
  }
}
