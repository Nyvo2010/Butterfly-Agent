import { readdir, readFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import type { ContextSlice, FileSnippet, GrepMatch, SCEOptions, Tokenizer } from "./types"

const DEFAULT_MAX_FILES = 5
const DEFAULT_MAX_TOKENS_PER_FILE = 2000
const DEFAULT_MAX_GREP_RESULTS = 50
const DEFAULT_TOP_FILES = 3

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next"])

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "you",
  "are",
  "your",
  "have",
  "has",
  "was",
  "were",
  "but",
  "not",
  "all",
  "any",
  "can",
  "use",
])

// Convert a free-form user query into a search regex. Natural-language sentences
// don't match verbatim, so extract unique word/dash tokens of length >= 3, drop
// stop words, escape regex metachars, and OR them together. Single-word /
// explicit-regex queries (e.g. "hello|world") still work because their tokens
// fall out naturally.
function queryToRegex(query: string): RegExp {
  if (query.trim() === "") {
    // Empty/whitespace queries have no search intent; return a never-matching
    // regex so we don't accidentally match every line (security/DoS guard).
    return /$.^/
  }
  const tokens = [
    ...new Set((query.match(/\b[\w-]{3,}\b/g) ?? []).map((t) => t.toLowerCase())),
  ].filter((t) => !STOP_WORDS.has(t))
  if (tokens.length === 0) {
    return new RegExp(escapeRegex(query), "im")
  }
  return new RegExp(tokens.map((t) => escapeRegex(t)).join("|"), "im")
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export class SCE {
  // MVP-SCOPE §5 note: the agent loop calls select() with the same query+options
  // every iteration. Cache the result so we only walk+grep once per session.
  private readonly cache = new Map<string, ContextSlice>()

  constructor(private readonly tokenizer: Tokenizer) {}

  async select(query: string, options: SCEOptions): Promise<ContextSlice> {
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
    const maxTokensPerFile = options.maxTokensPerFile ?? DEFAULT_MAX_TOKENS_PER_FILE
    const maxGrepResults = options.maxGrepResults ?? DEFAULT_MAX_GREP_RESULTS
    const topFiles = Math.min(options.topFiles ?? DEFAULT_TOP_FILES, maxFiles)

    // Cache key includes all options that affect the output, not just query + cwd.
    const key = `${query}::${options.cwd}::mf=${maxFiles}::mt=${maxTokensPerFile}::mg=${maxGrepResults}::tf=${topFiles}`
    const cached = this.cache.get(key)
    if (cached) return cached

    const grepMatches = await this.grep(query, options.cwd, maxGrepResults)

    const fileSet: string[] = []
    const seen = new Set<string>()
    for (const m of grepMatches) {
      if (seen.has(m.file)) continue
      seen.add(m.file)
      fileSet.push(m.file)
      if (fileSet.length >= topFiles) break
    }

    const fileSnippets: FileSnippet[] = []
    for (const path of fileSet.slice(0, maxFiles)) {
      const abs = join(options.cwd, path)
      let content: string
      try {
        content = await readFile(abs, "utf8")
      } catch {
        continue
      }
      const { text, tokens } = this.tokenizer.truncate(content, maxTokensPerFile)
      fileSnippets.push({ path, content: text, tokens })
    }

    const slice: ContextSlice = { grepMatches, fileSnippets }
    this.cache.set(key, slice)
    return slice
  }

  private async grep(query: string, cwd: string, maxResults: number): Promise<GrepMatch[]> {
    const re = queryToRegex(query)
    const matches: GrepMatch[] = []
    const files = await this.walk(cwd)
    for (const file of files) {
      if (matches.length >= maxResults) break
      let content: string
      try {
        content = await readFile(file, "utf8")
      } catch {
        continue
      }
      const lines = content.split("\n")
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (re.test(lines[i])) {
          matches.push({
            file: relative(cwd, file).split(sep).join("/"),
            line: i + 1,
            content: lines[i],
          })
          re.lastIndex = 0
        }
      }
    }
    return matches
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = []
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const subWalks: Promise<string[]>[] = []
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          subWalks.push(this.walk(full))
        } else if (e.isFile()) {
          out.push(full)
        }
      }
      // Gather sub-walk results concurrently, then sort for deterministic ordering.
      for (const result of await Promise.all(subWalks)) {
        out.push(...result)
      }
      out.sort()
    } catch {
      return out
    }
    return out
  }
}
