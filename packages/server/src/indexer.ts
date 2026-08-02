/**
 * Lightweight code identifier index — dependency-free.
 *
 * Walks a workspace, extracts identifier declarations (functions, classes,
 * interfaces, types, methods, constants) per language via conservative regex
 * heuristics, and answers substring/prefix queries fast. No external deps,
 * no LSP, no AST — just fast approximate symbol search for small/medium repos.
 *
 * Used by GET /api/search so clients can offer "jump to symbol" style search
 * without indexing the whole repo through a language server.
 */

import { readFile, stat } from "node:fs/promises"
import { extname, relative } from "node:path"
import { SKIP_DIRS, walk } from "@butterfly/core"

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "method"
  | "module"
  | "other"

export interface IndexedSymbol {
  name: string
  kind: SymbolKind
  /** Absolute path. */
  path: string
  /** Path relative to the workspace root. */
  relPath: string
  line: number
}

export interface IndexStats {
  files: number
  symbols: number
  indexedAt: string
  tookMs: number
}

/** File extensions to index. */
const INDEXABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".cs",
  ".sh",
])

/** Max file size to index (1MB) — skip generated/binary-adjacent blobs. */
const MAX_FILE_BYTES = 1_000_000
/** Max files to index per build (sanity cap). */
const MAX_FILES = 20_000

interface LanguagePatterns {
  kinds: Array<{ kind: SymbolKind; re: RegExp }>
}

/**
 * Per-language declaration heuristics. Conservative on purpose: false negatives
 * are fine (search falls back to grep/SCE), false positives are not.
 */
const PATTERNS: Record<string, LanguagePatterns> = {
  ts: {
    kinds: [
      { kind: "function", re: /\bfunction\s+([A-Za-z_$][\w$]*)/g },
      { kind: "class", re: /\bclass\s+([A-Za-z_$][\w$]*)/g },
      { kind: "interface", re: /\binterface\s+([A-Za-z_$][\w$]*)/g },
      { kind: "type", re: /\btype\s+([A-Za-z_$][\w$]*)\s*=/g },
      { kind: "const", re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|\()/g },
      { kind: "module", re: /\benum\s+([A-Za-z_$][\w$]*)/g },
    ],
  },
  py: {
    kinds: [
      { kind: "function", re: /^def\s+([a-zA-Z_]\w*)/gm },
      { kind: "class", re: /^class\s+([a-zA-Z_]\w*)/gm },
      { kind: "const", re: /^([A-Z_][A-Z0-9_]*)\s*=/gm },
    ],
  },
  go: {
    kinds: [
      { kind: "function", re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm },
      { kind: "type", re: /^type\s+([A-Za-z_]\w*)/gm },
      { kind: "const", re: /^const\s+([A-Za-z_]\w*)/gm },
    ],
  },
  rs: {
    kinds: [
      { kind: "function", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([a-z_]\w*)/gm },
      { kind: "class", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/gm },
      { kind: "type", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/gm },
      { kind: "interface", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/gm },
    ],
  },
  java: {
    kinds: [
      { kind: "class", re: /\bclass\s+([A-Za-z_]\w*)/g },
      { kind: "interface", re: /\binterface\s+([A-Za-z_]\w*)/g },
      { kind: "method", re: /\b(?:public|private|protected)\s+[\w<>[\]?,\s]+\s+([a-z_]\w*)\s*\(/g },
    ],
  },
  c: {
    kinds: [
      { kind: "function", re: /^[\w\s*]+\b([a-zA-Z_]\w*)\s*\([^;]*\)\s*\{/gm },
      { kind: "type", re: /^(?:typedef\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/gm },
    ],
  },
  rb: {
    kinds: [
      { kind: "method", re: /^def\s+([a-zA-Z_]\w*(?:[?!])?)/gm },
      { kind: "class", re: /^class\s+([A-Za-z_]\w*)/gm },
    ],
  },
  php: {
    kinds: [
      { kind: "function", re: /\bfunction\s+([a-zA-Z_]\w*)/g },
      { kind: "class", re: /\bclass\s+([A-Za-z_]\w*)/g },
    ],
  },
  swift: {
    kinds: [
      { kind: "function", re: /\bfunc\s+([a-zA-Z_]\w*)/g },
      { kind: "class", re: /\bclass\s+([A-Za-z_]\w*)/g },
      { kind: "interface", re: /\bprotocol\s+([A-Za-z_]\w*)/g },
    ],
  },
  kt: {
    kinds: [
      { kind: "function", re: /\bfun\s+([a-zA-Z_]\w*)/g },
      { kind: "class", re: /\bclass\s+([A-Za-z_]\w*)/g },
      { kind: "interface", re: /\binterface\s+([A-Za-z_]\w*)/g },
    ],
  },
  cs: {
    kinds: [
      { kind: "class", re: /\bclass\s+([A-Za-z_]\w*)/g },
      { kind: "interface", re: /\binterface\s+([A-Za-z_]\w*)/g },
      {
        kind: "method",
        re: /\b(?:public|private|protected|internal)\s+[\w<>[\]?,\s]+\s+([a-zA-Z_]\w*)\s*\(/g,
      },
    ],
  },
  sh: {
    kinds: [{ kind: "function", re: /^([a-zA-Z_]\w*)\s*\(\)\s*\{/gm }],
  },
}

function languageFor(ext: string): string | null {
  const key = ext.replace(".", "")
  if (key === "ts" || key === "tsx" || key === "mts" || key === "cts") return "ts"
  if (key === "js" || key === "jsx" || key === "mjs" || key === "cjs") return "ts"
  if (key === "c" || key === "h" || key === "cpp" || key === "hpp") return "c"
  if (PATTERNS[key]) return key
  return null
}

export class CodeIndexer {
  private symbols: IndexedSymbol[] = []
  private stats: IndexStats = {
    files: 0,
    symbols: 0,
    indexedAt: "",
    tookMs: 0,
  }

  constructor(private readonly root: string) {}

  /** Whether an index has been built for the current root. */
  get isBuilt(): boolean {
    return this.symbols.length > 0 || this.stats.files > 0
  }

  /** Build the identifier index by walking the workspace. Idempotent rebuild. */
  async build(): Promise<IndexStats> {
    const started = Date.now()
    const out: IndexedSymbol[] = []
    let files = 0

    try {
      const all = await walk(this.root, SKIP_DIRS)
      const candidates = all.filter((p) => INDEXABLE_EXTENSIONS.has(extname(p))).slice(0, MAX_FILES)
      // Limit parallel reads to avoid exhausting FDs on huge repos.
      const BATCH = 64
      for (let i = 0; i < candidates.length; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH)
        const results = await Promise.all(
          batch.map(async (path): Promise<IndexedSymbol[]> => {
            try {
              const info = await stat(path)
              if (info.size > MAX_FILE_BYTES) return []
              const content = await readFile(path, "utf8")
              return extractSymbols(content, path, this.root)
            } catch {
              return []
            }
          }),
        )
        for (const symbols of results) out.push(...symbols)
      }
      files = Math.min(candidates.length, MAX_FILES)
    } catch {
      // Walk failure → empty index (search falls back to 404/no-results).
    }

    this.symbols = out
    this.stats = {
      files,
      symbols: out.length,
      indexedAt: new Date().toISOString(),
      tookMs: Date.now() - started,
    }
    return this.stats
  }

  /**
   * Search the index. Scoring: exact match > prefix > substring, then by name
   * length (shorter names are more specific). Case-insensitive.
   */
  search(query: string, limit = 50): IndexedSymbol[] {
    const q = query.trim().toLowerCase()
    if (!q || this.symbols.length === 0) return []

    const scored: Array<{ symbol: IndexedSymbol; score: number }> = []
    for (const s of this.symbols) {
      const name = s.name.toLowerCase()
      let score: number
      if (name === q) score = 0
      else if (name.startsWith(q)) score = 1
      else if (name.includes(q)) score = 2
      else if (camelSplit(name).some((part) => part.startsWith(q))) score = 3
      else continue
      // Shorter exact/prefix matches rank above longer ones.
      score += name.length / 1000
      scored.push({ symbol: s, score })
    }

    scored.sort((a, b) => a.score - b.score || a.symbol.path.localeCompare(b.symbol.path))
    return scored.slice(0, limit).map((s) => s.symbol)
  }

  get statsView(): IndexStats {
    return { ...this.stats }
  }
}

/** Extract declaration symbols from file content. */
function extractSymbols(content: string, path: string, root: string): IndexedSymbol[] {
  const lang = languageFor(extname(path))
  if (!lang) return []
  const patterns = PATTERNS[lang]
  const out: IndexedSymbol[] = []
  const lines = content.split("\n")

  for (const { kind, re } of patterns.kinds) {
    // Reset lastIndex for global regex reuse.
    re.lastIndex = 0
    let match: RegExpExecArray | null
    match = re.exec(content)
    while (match !== null) {
      const name = match[1]
      if (!name || name === "_" || name === "default") {
        match = re.exec(content)
        continue
      }
      // Compute line number from match index.
      let line = 1
      let offset = 0
      for (let i = 0; i < lines.length; i++) {
        offset += lines[i].length + 1
        if (match.index < offset) {
          line = i + 1
          break
        }
      }
      // Skip obvious vendor/duplicate noise (test helpers named "test" etc.).
      out.push({
        name,
        kind,
        path,
        relPath: relative(root, path) || path,
        line,
      })
      match = re.exec(content)
    }
  }
  return out
}

/** Split a camelCase/PascalCase/snake_case identifier into word parts. */
function camelSplit(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
}
