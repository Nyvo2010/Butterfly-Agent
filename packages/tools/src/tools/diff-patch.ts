import { readFile, writeFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Tool } from "../types"

interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

/**
 * Minimal unified-diff parser. Parses standard `diff -u` output into hunks
 * that can be applied to a file. Handles the common cases: additions, deletions,
 * and modifications with context lines.
 */
function parseDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  const hunkHeaderRe = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/
  let current: Hunk | null = null

  for (const line of diff.split("\n")) {
    const headerMatch = line.match(hunkHeaderRe)
    if (headerMatch) {
      if (current) hunks.push(current)
      current = {
        oldStart: Number(headerMatch[1]),
        oldCount: Number(headerMatch[2] ?? 1),
        newStart: Number(headerMatch[3]),
        newCount: Number(headerMatch[4] ?? 1),
        lines: [],
      }
      continue
    }
    if (current && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line === "")) {
      current.lines.push(line)
    }
  }
  if (current) hunks.push(current)
  return hunks
}

/**
 * Apply parsed hunks to file content. Returns the patched content or an error.
 */
function applyHunks(original: string, hunks: Hunk[]): string | Error {
  const originalLines = original.split("\n")
  // Work backwards so line numbers from later hunks don't shift.
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart)

  for (const hunk of sorted) {
    const result = applyHunk(originalLines, hunk)
    if (result instanceof Error) return result
  }
  return originalLines.join("\n")
}

function applyHunk(lines: string[], hunk: Hunk): string[] | Error {
  const oldIdx = hunk.oldStart - 1 // 1-based to 0-based
  const expectedContext: string[] = []
  const newLines: string[] = []

  for (const line of hunk.lines) {
    if (line.startsWith(" ")) {
      // Context line — must match.
      const ctx = line.slice(1)
      expectedContext.push(ctx)
      newLines.push(ctx)
    } else if (line.startsWith("-")) {
      const removed = line.slice(1)
      expectedContext.push(removed)
      // Don't add to newLines.
    } else if (line.startsWith("+")) {
      const added = line.slice(1)
      newLines.push(added)
    } else {
      // Empty context line or trailing whitespace.
      expectedContext.push(line)
      newLines.push(line)
    }
  }

  // Verify context matches.
  if (expectedContext.length > 0) {
    const actualSlice = lines.slice(oldIdx, oldIdx + expectedContext.length)
    let mismatches = 0
    for (let i = 0; i < expectedContext.length; i++) {
      // Removed lines in the diff appear in expectedContext but not in newLines.
      // We check only context lines (not removed ones) against the file.
      const hunkLine = hunk.lines[i]
      if (hunkLine?.startsWith("-")) continue // skip removed lines in verification
      if (actualSlice[i] !== expectedContext[i]) {
        mismatches++
      }
    }
    if (mismatches > 0) {
      return new Error(
        `Hunk context does not match file content at line ${hunk.oldStart}. ` +
          `Expected: "${expectedContext.slice(0, 3).join("\\n")}"... ` +
          `Got: "${actualSlice.slice(0, 3).join("\\n")}"...`,
      )
    }
  }

  // Remove old lines, insert new lines.
  const removeCount = hunk.lines.filter((l) => l.startsWith("-") || l.startsWith(" ")).length
  lines.splice(oldIdx, removeCount, ...newLines)
  return lines
}

export const diffPatchTool: Tool<{ patched: boolean; hunksApplied: number }> = {
  name: "diff_patch",
  description:
    "Apply a unified diff patch to a file. Accepts standard diff -u format. " +
    "Errors if the patch context does not match the file content.",
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to patch" },
      diff: { type: "string", description: "Unified diff content (diff -u format)" },
    },
    required: ["path", "diff"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const path = String(input.path ?? "")
    const diff = String(input.diff ?? "")
    if (!path) return { kind: "err", message: "path is required" }
    if (!diff) return { kind: "err", message: "diff is required" }
    const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path)

    let original: string
    try {
      original = await readFile(abs, "utf8")
    } catch (err) {
      return { kind: "err", message: `diff_patch: cannot read file: ${(err as Error).message}` }
    }

    const hunks = parseDiff(diff)
    if (hunks.length === 0) {
      return { kind: "err", message: "diff_patch: no hunks found in diff" }
    }

    const result = applyHunks(original, hunks)
    if (result instanceof Error) {
      return { kind: "err", message: `diff_patch: ${result.message}` }
    }

    try {
      await writeFile(abs, result, "utf8")
      return { kind: "ok", output: { patched: true, hunksApplied: hunks.length } }
    } catch (err) {
      return { kind: "err", message: `diff_patch: write failed: ${(err as Error).message}` }
    }
  },
}
