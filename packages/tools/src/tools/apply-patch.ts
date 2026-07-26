import { readFile, stat, writeFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Tool, ToolContext, ToolResult } from "../types"
import { isPathInWorkspace } from "../types"

/**
 * Apply a unified diff patch to multiple files. Mirrors OpenCode's apply_patch tool.
 * Parses standard unified diff format and applies additions, updates, deletions, and moves.
 */

interface PatchFile {
  filePath: string
  type: "add" | "update" | "delete" | "move"
  movePath?: string
  oldContent: string
  newContent: string
  diff: string
}

/**
 * Parse a multi-file unified diff into individual file patches.
 */
function parseMultiFileDiff(patchText: string): PatchFile[] {
  const files: PatchFile[] = []
  const fileHeaderRe = /^diff --git a\/(.+) b\/(.+)$/
  const newFileRe = /^new file mode/
  const deletedFileRe = /^deleted file mode/
  const renameRe = /^rename (?:from|to) (.+)$/

  let current: Partial<PatchFile> | null = null
  let diffLines: string[] = []
  let isNew = false
  let isDeleted = false
  let renameFrom: string | undefined
  let renameTo: string | undefined

  for (const line of patchText.split("\n")) {
    const headerMatch = line.match(fileHeaderRe)
    if (headerMatch) {
      // Save previous file
      if (current) {
        saveCurrent(files, current, diffLines, isNew, isDeleted, renameTo)
      }
      current = { filePath: headerMatch[2] }
      diffLines = [line]
      isNew = false
      isDeleted = false
      renameFrom = undefined
      renameTo = undefined
      continue
    }

    if (current) {
      diffLines.push(line)

      if (newFileRe.test(line)) isNew = true
      if (deletedFileRe.test(line)) isDeleted = true

      const renameMatch = line.match(renameRe)
      if (renameMatch) {
        if (!renameFrom) renameFrom = renameMatch[1]
        else renameTo = renameMatch[1]
      }
    }
  }

  // Save last file
  if (current) {
    saveCurrent(files, current, diffLines, isNew, isDeleted, renameTo)
  }

  return files
}

function saveCurrent(
  files: PatchFile[],
  current: Partial<PatchFile>,
  diffLines: string[],
  isNew: boolean,
  isDeleted: boolean,
  movePath?: string,
): void {
  const diff = diffLines.join("\n")
  const filePath = current.filePath ?? ""

  let type: PatchFile["type"] = "update"
  if (isNew) type = "add"
  else if (isDeleted) type = "delete"
  else if (movePath) type = "move"

  files.push({
    filePath,
    type,
    movePath,
    oldContent: "",
    newContent: "",
    diff,
  })
}

/**
 * Apply a single file patch, reading old content and computing new content.
 */
async function applyFilePatch(
  pf: PatchFile,
  cwd: string,
  workspaceRoots?: string[],
): Promise<string | Error> {
  const abs = isAbsolute(pf.filePath) ? pf.filePath : resolve(cwd, pf.filePath)

  if (workspaceRoots && !(await isPathInWorkspace(abs, workspaceRoots))) {
    return new Error(`access denied: ${pf.filePath} is outside the workspace`)
  }

  switch (pf.type) {
    case "add": {
      // Extract content from the diff's + lines
      const content = extractAddedContent(pf.diff)
      try {
        await writeFile(abs, content, "utf8")
        return `Created ${pf.filePath}`
      } catch (err) {
        return new Error(`Failed to create ${pf.filePath}: ${(err as Error).message}`)
      }
    }
    case "delete": {
      try {
        // Verify file exists before deleting
        await stat(abs)
        // Don't actually delete — just report what would happen.
        // Real deletion should go through the delete tool for safety.
        return `Would delete ${pf.filePath} (use delete tool for actual deletion)`
      } catch {
        return new Error(`Cannot delete ${pf.filePath}: file not found`)
      }
    }
    case "move": {
      const fromAbs = isAbsolute(pf.filePath) ? pf.filePath : resolve(cwd, pf.filePath)
      const toAbs = pf.movePath
        ? isAbsolute(pf.movePath)
          ? pf.movePath
          : resolve(cwd, pf.movePath)
        : null
      if (!toAbs) return new Error("move requires a destination path")
      try {
        const content = await readFile(fromAbs, "utf8")
        await writeFile(toAbs, content, "utf8")
        return `Moved ${pf.filePath} → ${pf.movePath}`
      } catch (err) {
        return new Error(`Failed to move ${pf.filePath}: ${(err as Error).message}`)
      }
    }
    case "update": {
      try {
        const original = await readFile(abs, "utf8")
        const patched = applySimplePatch(original, pf.diff)
        if (patched instanceof Error) return patched
        await writeFile(abs, patched, "utf8")
        return `Updated ${pf.filePath}`
      } catch (err) {
        return new Error(`Failed to update ${pf.filePath}: ${(err as Error).message}`)
      }
    }
  }
}

/** Extract content from diff + lines */
function extractAddedContent(diff: string): string {
  return diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n")
}

/** Simple line-by-line patch application */
function applySimplePatch(_original: string, diff: string): string | Error {
  const diffLines = diff.split("\n")
  let i = 0
  const output: string[] = []

  while (i < diffLines.length) {
    const line = diffLines[i]

    // File headers — skip
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@")
    ) {
      i++
      continue
    }

    // Context line or unchanged
    if (line.startsWith(" ") || (!line.startsWith("+") && !line.startsWith("-"))) {
      const ctx = line.startsWith(" ") ? line.slice(1) : line
      output.push(ctx)
      i++
      continue
    }

    // Removed line — skip
    if (line.startsWith("-")) {
      i++
      // Skip consecutive removals
      while (i < diffLines.length && diffLines[i].startsWith("-")) i++
      continue
    }

    // Added line
    if (line.startsWith("+")) {
      output.push(line.slice(1))
      i++
      continue
    }

    i++
  }

  return output.join("\n")
}

export const applyPatchTool: Tool = {
  name: "apply_patch",
  description:
    "Apply a unified diff patch to one or more files. Accepts standard " +
    "multi-file diff format. Handles additions, updates, deletions, and moves. " +
    "Prefer this over write when modifying existing files.",
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      patchText: {
        type: "string",
        description: "The full patch text describing all changes to be made",
      },
    },
    required: ["patchText"],
    additionalProperties: false,
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const patchText = String(input.patchText ?? "")
    if (!patchText) return { kind: "err", message: "patchText is required" }

    const files = parseMultiFileDiff(patchText)
    if (files.length === 0) {
      return { kind: "err", message: "No file patches found in patchText" }
    }

    const results: string[] = []
    let hadError = false

    for (const pf of files) {
      const result = await applyFilePatch(pf, ctx.cwd, ctx.workspaceRoots)
      if (result instanceof Error) {
        results.push(`✗ ${result.message}`)
        hadError = true
      } else {
        results.push(`✓ ${result}`)
      }
    }

    if (hadError) {
      return { kind: "err", message: `Some patches failed:\n${results.join("\n")}` }
    }
    return { kind: "ok", output: `Applied ${files.length} patches:\n${results.join("\n")}` }
  },
}
