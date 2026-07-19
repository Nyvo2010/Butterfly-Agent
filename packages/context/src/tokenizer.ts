import { decode, encode } from "gpt-tokenizer"
import type { Tokenizer } from "./types"

export class GPTTokenizer implements Tokenizer {
  count(text: string): number {
    return encode(text).length
  }

  truncate(text: string, maxTokens: number): { text: string; tokens: number } {
    if (maxTokens <= 0) return { text: "", tokens: 0 }
    const tokens = encode(text)
    if (tokens.length <= maxTokens) return { text, tokens: tokens.length }
    return { text: decode(tokens.slice(0, maxTokens)), tokens: maxTokens }
  }
}
