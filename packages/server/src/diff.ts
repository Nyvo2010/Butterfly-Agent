/**
 * Dependency-free unified diff generator.
 *
 * Computes a line-based LCS diff between two strings and renders it in
 * standard unified-diff format (diff -u). Used by the session diff/rollback
 * HTTP API so clients can render "what changed" without a git dependency.
 *
 * Pure functions, no I/O — easy to unit test.
 */

export interface DiffLine {
  type: "context" | "add" | "delete"
  text: string
}

/** Compute the LCS length table for two line arrays. */
function lcsTable(a: string[], b: string[]): Uint32Array[] {
  const n = a.length
  const m = b.length
  const table: Uint32Array[] = []
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

/** Backtrack the LCS table into an aligned diff line sequence. */
function backtrack(a: string[], b: string[], table: Uint32Array[]): DiffLine[] {
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: "delete", text: a[i] })
      i++
    } else {
      out.push({ type: "add", text: b[j] })
      j++
    }
  }
  while (i < a.length) {
    out.push({ type: "delete", text: a[i] })
    i++
  }
  while (j < b.length) {
    out.push({ type: "add", text: b[j] })
    j++
  }
  return out
}

/**
 * Group a diff line sequence into hunks with context (3 lines default).
 * Splits on \n; a trailing empty element (from a final newline) is dropped so
 * line counts match what `diff -u` reports for newline-terminated files.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  // Fast path: identical.
  if (a.length === b.length && a.every((l, i) => l === b[i])) return []
  return backtrack(a, b, lcsTable(a, b))
}

/** Split text into content lines, dropping the final-newline artifact. */
function splitLines(text: string): string[] {
  if (text === "") return [""]
  const lines = text.split("\n")
  // "a\n" → ["a", ""]; the trailing "" is the newline terminator, not content.
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * Render a line diff as a unified diff string.
 * Returns an empty string when there are no changes.
 */
export function renderUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  contextLines = 3,
): string {
  const lines = diffLines(before, after)
  if (lines.length === 0) return ""

  // Split into hunks (with their start index in `lines`) separated by more
  // than 2*contextLines of context.
  const hunks: Array<{ start: number; lines: DiffLine[] }> = []
  let current: DiffLine[] = []
  let currentStart = 0
  let contextRun = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.type === "context") {
      contextRun++
      if (current.length > 0 && contextRun > contextLines * 2) {
        hunks.push({ start: currentStart, lines: current })
        current = [line]
        currentStart = i
        contextRun = 1
      } else {
        current.push(line)
      }
    } else {
      contextRun = 0
      current.push(line)
    }
  }
  if (current.length > 0) hunks.push({ start: currentStart, lines: current })

  // Trim each hunk's context to contextLines around changes.
  const trimmed = hunks.map((hunk) => ({
    start: hunk.start + trimOffset(hunk.lines, contextLines),
    lines: trimHunk(hunk.lines, contextLines),
  }))

  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`]

  // Walk the full diff once with running line counters — hunk positions are
  // computed from true indices, never indexOf (which breaks on repeated lines).
  let oldLine = 1
  let newLine = 1
  let cursor = 0

  for (const hunk of trimmed) {
    // Advance position counters to the hunk's start.
    while (cursor < hunk.start) {
      const t = lines[cursor]
      if (t.type !== "add") oldLine++
      if (t.type !== "delete") newLine++
      cursor++
    }

    let oldCount = 0
    let newCount = 0
    for (const line of hunk.lines) {
      if (line.type !== "add") oldCount++
      if (line.type !== "delete") newCount++
    }
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`)
    for (const line of hunk.lines) {
      const prefix = line.type === "add" ? "+" : line.type === "delete" ? "-" : " "
      out.push(`${prefix}${line.text}`)
      if (line.type !== "add") oldLine++
      if (line.type !== "delete") newLine++
      cursor++
    }
  }

  return out.join("\n")
}

/** Number of leading context lines trimmed off a hunk (for start adjustment). */
function trimOffset(hunk: DiffLine[], contextLines: number): number {
  const changeIdx = hunk.map((l, i) => (l.type !== "context" ? i : -1)).filter((i) => i !== -1)
  if (changeIdx.length === 0) return 0
  return Math.max(0, changeIdx[0] - contextLines)
}

/** Keep only contextLines of context around each change region within a hunk. */
function trimHunk(hunk: DiffLine[], contextLines: number): DiffLine[] {
  // Find change indices.
  const changeIdx = hunk.map((l, i) => (l.type !== "context" ? i : -1)).filter((i) => i !== -1)
  if (changeIdx.length === 0) return hunk

  const firstChange = changeIdx[0]
  const lastChange = changeIdx[changeIdx.length - 1]
  const start = Math.max(0, firstChange - contextLines)
  const end = Math.min(hunk.length, lastChange + contextLines + 1)
  return hunk.slice(start, end)
}

/** Generate a unified diff for a file change pair (path, before, after). */
export function unifiedDiffForFile(
  path: string,
  before: string | undefined,
  after: string | undefined,
): string {
  const beforeText = before ?? ""
  const afterText = after ?? ""
  if (before === undefined && after === undefined) return ""
  return renderUnifiedDiff(path, beforeText, afterText)
}
