import type { SessionMessage } from "@butterfly/session"

/** A single match from a grep search. */
export interface GrepMatch {
  file: string
  line: number
  content: string
}

/** A snippet of file content with its token count. */
export interface FileSnippet {
  path: string
  content: string
  tokens: number
}

/** Result of a context query: grep matches, file snippets, and optional warnings. */
export interface ContextSlice {
  readonly grepMatches: readonly GrepMatch[]
  readonly fileSnippets: readonly FileSnippet[]
  readonly warnings: readonly string[]
}

/** Options for Smart Context Engine queries. */
export interface SCEOptions {
  /** Working directory for file resolution. */
  cwd: string
  /** Maximum files to include (default 5). */
  maxFiles?: number
  /** Maximum tokens per file snippet (default 2000). */
  maxTokensPerFile?: number
  /** Maximum grep results (default 50). */
  maxGrepResults?: number
  /** Number of top files to expand from grep (default 3). */
  topFiles?: number
  /** Skip the 30s cache and force a fresh scan (e.g., after file mutations). */
  skipCache?: boolean
}

/**
 * Semantic compressor function.
 * Receives messages to compress and a token budget (in tokens) to meet.
 * Should return a compressed set of messages that fit within the budget.
 * May throw on failure — callers should wrap in try/catch.
 */
export type Compressor = (
  messages: SessionMessage[],
  /** Target token budget (in tokens) that compressed output should fit within. */
  budget: number,
) => Promise<SessionMessage[]>

/** Options for Context Optimization Engine. */
export interface COEOptions {
  /** Hard cap for total message tokens. */
  maxContextTokens: number
  /** Per-tool-message truncation cap (default 2000). */
  toolMessageMaxTokens?: number
  /** Optional semantic compressor for pre-drop compression pass. */
  compressor?: Compressor
}

/**
 * Tokenizer interface for counting and truncating text by tokens.
 * Implementations should handle edge cases (null/undefined text,
 * NaN/Infinity limits) gracefully.
 */
export interface Tokenizer {
  count(text: string): number
  truncate(text: string, maxTokens: number): { text: string; tokens: number }
}
