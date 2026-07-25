import { log } from "@butterfly/core"
import { decode, encode } from "gpt-tokenizer"
import type { Tokenizer } from "./types"

/**
 * Character-based tokenizer using the standard 4-char ≈ 1-token approximation.
 * Used as a universal fallback for non-OpenAI models (Claude, Mistral, Gemini, etc.)
 * where accurate token counting via gpt-tokenizer would produce misleading results.
 */
export class CharacterTokenizer implements Tokenizer {
  private cache = new Map<string, number>()
  private readonly CACHE_MAX = 100

  count(text: string): number {
    if (text === null || text === undefined) {
      throw new Error("CharacterTokenizer.count: text is null or undefined")
    }
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached
    const tokens = Math.ceil(text.length / 4)
    // Only cache reasonably-sized strings to avoid unbounded memory growth.
    if (text.length < 10_000) {
      this.cache.set(text, tokens)
      if (this.cache.size > this.CACHE_MAX) {
        const firstKey = this.cache.keys().next().value
        if (firstKey) this.cache.delete(firstKey)
      }
    }
    return tokens
  }

  truncate(text: string, maxTokens: number): { text: string; tokens: number } {
    if (text === null || text === undefined) {
      throw new Error("CharacterTokenizer.truncate: text is null or undefined")
    }
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      return { text: "", tokens: 0 }
    }
    const maxChars = maxTokens * 4
    // Guard against overflow from Infinity * 4 = Infinity.
    if (!Number.isFinite(maxChars)) return { text: "", tokens: 0 }
    if (text.length <= maxChars) return { text, tokens: Math.ceil(text.length / 4) }
    // Walk back to avoid splitting multi-byte UTF-8 characters.
    let end = maxChars
    while (end > 0 && (text.charCodeAt(end - 1) & 0xfc00) === 0xdc00) end--
    return { text: text.slice(0, end), tokens: Math.ceil(end / 4) }
  }
}

/**
 * Factory: select the right tokenizer for a given model.
 * Uses GPTTokenizer for OpenAI/gpt models, CharacterTokenizer fallback for others.
 */
export function createTokenizer(model?: string): Tokenizer {
  if (model && /gpt|openai|o1|o3/i.test(model)) {
    return new GPTTokenizer()
  }
  // Default to CharacterTokenizer for non-OpenAI models.
  // GPTTokenizer's cl100k_base counts are misleading for Claude, Mistral, etc.
  return new CharacterTokenizer()
}

export class GPTTokenizer implements Tokenizer {
  private cache = new Map<string, number>()
  private readonly CACHE_MAX = 100

  /**
   * Pre-warm the tokenizer by encoding an empty string.
   * Call during startup to avoid cold-start latency.
   */
  warmup(): void {
    encode("")
  }

  count(text: string): number {
    if (text === null || text === undefined) {
      throw new Error("GPTTokenizer.count: text is null or undefined")
    }
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached

    let tokens: number
    try {
      tokens = encode(text).length
    } catch (err) {
      log("warn", "tokenizer.encode_failed", { error: (err as Error).message })
      tokens = Math.ceil(text.length / 4)
    }
    // Only cache reasonably-sized strings to avoid unbounded memory.
    if (text.length < 10_000) {
      this.cache.set(text, tokens)
      if (this.cache.size > this.CACHE_MAX) {
        const firstKey = this.cache.keys().next().value
        if (firstKey) this.cache.delete(firstKey)
      }
    }
    return tokens
  }

  truncate(text: string, maxTokens: number): { text: string; tokens: number } {
    if (text === null || text === undefined) {
      throw new Error("GPTTokenizer.truncate: text is null or undefined")
    }
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      return { text: "", tokens: 0 }
    }

    try {
      const tokens = encode(text)
      if (tokens.length <= maxTokens) return { text, tokens: tokens.length }
      const decoded = decode(tokens.slice(0, maxTokens))
      const valid = typeof decoded === "string"
      return { text: valid ? decoded : text.slice(0, maxTokens * 4), tokens: maxTokens }
    } catch (err) {
      log("warn", "tokenizer.truncate_failed", { error: (err as Error).message })
      const truncated = text.slice(0, maxTokens * 4)
      return { text: truncated, tokens: Math.ceil(truncated.length / 4) }
    }
  }
}
