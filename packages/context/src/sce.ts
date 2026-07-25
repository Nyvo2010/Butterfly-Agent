import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { promisify } from "node:util"
import { isBinaryFile, log, walkWithDefaults } from "@butterfly/core"
import type { ContextSlice, FileSnippet, GrepMatch, SCEOptions, Tokenizer } from "./types"

const execFileAsync = promisify(execFile)

const DEFAULT_MAX_FILES = 5
const DEFAULT_MAX_TOKENS_PER_FILE = 2000
const DEFAULT_MAX_GREP_RESULTS = 50
const DEFAULT_TOP_FILES = 3

// Max file size to read for snippets (1MB). Larger files are skipped.
const MAX_FILE_BYTES = 1 * 1024 * 1024

// Max file size to read during grep (5MB).
const MAX_GREP_FILE_BYTES = 5 * 1024 * 1024

const CACHE_TTL_MS = 30_000
const READ_CONCURRENCY = 5

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

interface CacheEntry {
  slice: ContextSlice
  timestamp: number
}

function queryToRegex(query: string): RegExp {
  if (query.trim() === "") {
    return /$.^/
  }
  const tokens = [
    ...new Set((query.match(/\b[\w-]{2,}\b/g) ?? []).map((t) => t.toLowerCase())),
  ].filter((t) => !STOP_WORDS.has(t))
  if (tokens.length === 0) {
    try {
      return new RegExp(escapeRegex(query), "im")
    } catch {
      return /$.^/
    }
  }
  try {
    return new RegExp(tokens.map((t) => escapeRegex(t)).join("|"), "im")
  } catch {
    return /$.^/
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function countMeaningfulTokens(query: string): number {
  const tokens = [
    ...new Set((query.match(/\b[\w-]{3,}\b/g) ?? []).map((t) => t.toLowerCase())),
  ].filter((t) => !STOP_WORDS.has(t))
  return tokens.length
}

export class SCE {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<ContextSlice>>()

  constructor(private readonly tokenizer: Tokenizer) {}

  /**
   * Select relevant context for a query.
   * Returns grep matches, file snippets, and any non-fatal warnings (e.g., skipped files).
   * Throws if cwd is invalid; returns partial results with warnings on I/O errors.
   */
  async select(query: string, options: SCEOptions): Promise<ContextSlice> {
    // Validate cwd
    try {
      const cwdStat = await stat(options.cwd)
      if (!cwdStat.isDirectory()) {
        throw new Error(`cwd is not a directory: ${options.cwd}`)
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("cwd is not a directory")) throw err
      throw new Error(`SCE: invalid cwd "${options.cwd}": ${(err as Error).message}`)
    }

    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
    const maxTokensPerFile = options.maxTokensPerFile ?? DEFAULT_MAX_TOKENS_PER_FILE
    const maxGrepResults = options.maxGrepResults ?? DEFAULT_MAX_GREP_RESULTS
    const topFiles = Math.min(options.topFiles ?? DEFAULT_TOP_FILES, maxFiles)

    const meaningfulTokens = countMeaningfulTokens(query)
    if (meaningfulTokens < 3 && query.trim().length > 0) {
      log("warn", "sce.short_query", { query: query.slice(0, 200) })
    }

    // Cache key uses all options that affect the output, including skipCache
    // so that a skipCache=true call never races with a cached entry.
    const key = JSON.stringify({
      query,
      cwd: options.cwd,
      maxFiles,
      maxTokensPerFile,
      maxGrepResults,
      topFiles,
      skipCache: options.skipCache ?? false,
    })

    // Return cached entry if within TTL and not explicitly skipped.
    if (!options.skipCache) {
      const cached = this.cache.get(key)
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return { ...cached.slice, warnings: [] }
      }
    }

    // Deduplicate concurrent select() calls with the same key.
    const inflight = this.inflight.get(key)
    if (inflight) return inflight

    const promise = this.executeSelect(
      query,
      options.cwd,
      maxFiles,
      maxTokensPerFile,
      maxGrepResults,
      topFiles,
    )
    this.inflight.set(key, promise)

    try {
      const slice = await promise
      this.cache.set(key, { slice, timestamp: Date.now() })
      // Evict oldest entry if cache grows too large.
      if (this.cache.size > 20) {
        const firstKey = this.cache.keys().next().value
        if (firstKey) this.cache.delete(firstKey)
      }
      return slice
    } finally {
      this.inflight.delete(key)
    }
  }

  private async executeSelect(
    query: string,
    cwd: string,
    maxFiles: number,
    maxTokensPerFile: number,
    maxGrepResults: number,
    topFiles: number,
  ): Promise<ContextSlice> {
    const warnings: string[] = []
    const grepMatches = await this.grep(query, cwd, maxGrepResults)

    const fileSet: string[] = []
    const seen = new Set<string>()
    for (const m of grepMatches) {
      if (seen.has(m.file)) continue
      seen.add(m.file)
      fileSet.push(m.file)
      if (fileSet.length >= topFiles) break
    }

    const fileSnippets: FileSnippet[] = []
    const paths = fileSet.slice(0, maxFiles).map((p) => ({ abs: join(cwd, p), path: p }))
    let skippedFiles = 0

    // Read files concurrently in batches to limit I/O pressure.
    for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
      const batch = paths.slice(i, i + READ_CONCURRENCY)
      const results = await Promise.all(
        batch.map(async ({ abs, path }) => {
          try {
            const st = await stat(abs)
            if (st.size > MAX_FILE_BYTES) {
              skippedFiles++
              log("debug", "sce.skip_large_file", { path: abs, size: st.size })
              return null
            }
            if (await isBinaryFile(abs)) {
              skippedFiles++
              log("debug", "sce.skip_binary", { path: abs })
              return null
            }
            const content = await readFile(abs, "utf8")
            const { text, tokens } = this.tokenizer.truncate(content, maxTokensPerFile)
            return { path, content: text, tokens } as FileSnippet
          } catch (err) {
            skippedFiles++
            log("debug", "sce.read_error", { path: abs, error: (err as Error).message })
            return null
          }
        }),
      )
      for (const r of results) {
        if (r) fileSnippets.push(r)
      }
    }

    if (skippedFiles > 0) {
      warnings.push(`Skipped ${skippedFiles} file(s) due to size, binary content, or read errors.`)
    }
    return { grepMatches, fileSnippets, warnings }
  }

  /**
   * Try to use ripgrep (rg) binary for fast search. Falls back to Node.js
   * file-walking grep when ripgrep is not available.
   */
  private async grep(query: string, cwd: string, maxResults: number): Promise<GrepMatch[]> {
    const re = queryToRegex(query)
    if (re.toString() === "/$.^/") return []

    // Build a ripgrep-compatible pattern from the regex.
    // queryToRegex returns an alternation of escaped tokens (e.g., /resolve|model/im).
    // Ripgrep handles regex natively, so pass the alternation pattern directly.
    const tokens = [
      ...new Set((query.match(/\b[\w-]{2,}\b/g) ?? []).map((t) => t.toLowerCase())),
    ].filter((t) => !STOP_WORDS.has(t))

    if (tokens.length === 0 && query.trim()) {
      // No extractable tokens — use fixed-string search to avoid ripgrep
      // interpreting raw user query as regex (could error on metacharacters).
      try {
        return await this.ripgrepFixedSearch(query.trim(), cwd, maxResults)
      } catch {
        log("debug", "sce.ripgrep_fixed_unavailable", { cwd })
        return this.nodeGrep(re, cwd, maxResults)
      }
    }

    const rgPattern = tokens.join("|")
    if (!rgPattern) return []

    try {
      return await this.ripgrepSearch(rgPattern, cwd, maxResults)
    } catch {
      // Ripgrep unavailable or failed — fall back to Node.js file-walking.
      log("debug", "sce.ripgrep_unavailable", { cwd })
      return this.nodeGrep(re, cwd, maxResults)
    }
  }

  /**
   * Build ripgrep arguments shared across regex and fixed-string modes.
   */
  private ripgrepArgs(pattern: string, maxResults: number, fixedStrings: boolean): string[] {
    return [
      "--no-heading",
      "--with-filename",
      "--line-number",
      "--max-count",
      String(maxResults),
      "--max-filesize",
      `${MAX_GREP_FILE_BYTES}`,
      "--glob",
      "!node_modules",
      "--glob",
      "!.git",
      "--glob",
      "!dist",
      "--glob",
      "!build",
      "--glob",
      "!.turbo",
      "--glob",
      "!.next",
      ...(fixedStrings ? ["-F"] : []),
      "-e",
      pattern,
    ]
  }

  /**
   * Search using the ripgrep binary. Fast — uses native code with
   * automatic .gitignore honoring, binary-file skipping, and parallel I/O.
   */
  private async ripgrepSearch(
    pattern: string,
    cwd: string,
    maxResults: number,
  ): Promise<GrepMatch[]> {
    const args = this.ripgrepArgs(pattern, maxResults, false)

    const { stdout } = await execFileAsync("rg", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: 10_000,
    })

    const matches: GrepMatch[] = []
    for (const line of stdout.split("\n")) {
      if (!line.trim() || matches.length >= maxResults) break
      // ripgrep output format: "file:line:content"
      const colonIdx = line.indexOf(":")
      if (colonIdx === -1) continue
      const secondColon = line.indexOf(":", colonIdx + 1)
      if (secondColon === -1) continue
      const file = line.slice(0, colonIdx)
      const lineNum = Number.parseInt(line.slice(colonIdx + 1, secondColon), 10)
      const content = line.slice(secondColon + 1)
      if (!Number.isNaN(lineNum)) {
        matches.push({ file, line: lineNum, content })
      }
    }
    return matches
  }

  /**
   * Fixed-string search using ripgrep (no regex interpretation).
   * Used when the query has no extractable keyword tokens, to avoid
   * ripgrep interpreting user input containing regex metacharacters.
   */
  private async ripgrepFixedSearch(
    pattern: string,
    cwd: string,
    maxResults: number,
  ): Promise<GrepMatch[]> {
    const args = this.ripgrepArgs(pattern, maxResults, true)

    const { stdout } = await execFileAsync("rg", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10_000,
    })

    const matches: GrepMatch[] = []
    for (const line of stdout.split("\n")) {
      if (!line.trim() || matches.length >= maxResults) break
      const colonIdx = line.indexOf(":")
      if (colonIdx === -1) continue
      const secondColon = line.indexOf(":", colonIdx + 1)
      if (secondColon === -1) continue
      const file = line.slice(0, colonIdx)
      const lineNum = Number.parseInt(line.slice(colonIdx + 1, secondColon), 10)
      const content = line.slice(secondColon + 1)
      if (!Number.isNaN(lineNum)) {
        matches.push({ file, line: lineNum, content })
      }
    }
    return matches
  }

  /**
   * Fallback: walk filesystem tree and grep each file with Node.js regex.
   * Slower than ripgrep but works without external dependencies.
   */
  private async nodeGrep(
    re: RegExp,
    cwd: string,
    maxResults: number,
  ): Promise<GrepMatch[]> {
    const matches: GrepMatch[] = []
    const files = await walkWithDefaults(cwd)
    for (const file of files) {
      if (matches.length >= maxResults) break
      try {
        const st = await stat(file)
        if (st.size > MAX_GREP_FILE_BYTES) continue
      } catch {
        continue
      }
      let content: string
      try {
        content = await readFile(file, "utf8")
      } catch {
        continue
      }
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (re.test(lines[i])) {
          matches.push({
            file: relative(cwd, file).split(sep).join("/"),
            line: i + 1,
            content: lines[i],
          })
        }
      }
    }
    return matches
  }
}
