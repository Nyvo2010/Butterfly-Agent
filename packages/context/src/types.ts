// Public types for SCE, COE, and Tokenizer. The Agent Loop (Phase C) consumes these
// directly; COE operates on SessionState from @butterfly/session.

import type { SessionMessage } from "@butterfly/session"

export interface GrepMatch {
  file: string
  line: number
  content: string
}

export interface FileSnippet {
  path: string
  content: string
  tokens: number
}

export interface ContextSlice {
  grepMatches: GrepMatch[]
  fileSnippets: FileSnippet[]
}

export interface SCEOptions {
  cwd: string
  /** MVP-SCOPE §5: max 5 files */
  maxFiles?: number
  /** MVP-SCOPE §5: max 2000 tokens per file */
  maxTokensPerFile?: number
  /** MVP-SCOPE §5: max 50 grep results */
  maxGrepResults?: number
  /** MVP-SCOPE §5: expand top-N files from grep (default 3) */
  topFiles?: number
}

export type Compressor = (
  messages: SessionMessage[],
  budget: number,
) => Promise<SessionMessage[]>

export interface COEOptions {
  /** Hard cap for total message tokens. */
  maxContextTokens: number
  /** Per-tool-message truncation cap. Default 2000. */
  toolMessageMaxTokens?: number
  /** Optional semantic compressor for Pass 3. */
  compressor?: Compressor
}

export interface Tokenizer {
  count(text: string): number
  truncate(text: string, maxTokens: number): { text: string; tokens: number }
}
