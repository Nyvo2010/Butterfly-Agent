/**
 * File route group — read-only file operations for the client.
 *
 * The client needs to browse and read files to render diffs, file trees, and
 * file contents. All operations are read-only and workspace-root-bound for
 * security. Inspired by OpenCode's file route group.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { relative, resolve as resolvePath } from "node:path"
import { walkWithDefaults } from "@butterfly/core"
import type { ServerApp } from "../app"
import type { Router } from "../router"
import { badRequest, notFound, ok, serverError } from "../router"

const MAX_FILE_BYTES = 1_000_000

/** Resolve a path within the workspace root, preventing traversal. */
function safePath(cwd: string, rawPath: string): string {
  const resolved = resolvePath(cwd, rawPath)
  const rel = relative(cwd, resolved)
  if (rel.startsWith("..")) {
    throw new Error(`Path traversal detected: ${rawPath}`)
  }
  return resolved
}

/** Basic glob matcher — supports * and ** wildcards. */
function matchGlob(name: string, pattern: string): boolean {
  if (pattern === "**/*" || pattern === "*") return true
  const regexStr = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${regexStr}$`).test(name)
}

export function registerFileRoutes(router: Router, app: ServerApp): void {
  const cwd = app.cwd

  // ── List directory ─────────────────────────────────────────────────────
  router.get("/api/file", async (ctx) => {
    const dirPath = ctx.query.path ?? "."
    try {
      const abs = safePath(cwd, dirPath)
      const entries = await readdir(abs, { withFileTypes: true })
      const items = entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
      }))
      ok(ctx.res, { path: dirPath, entries: items })
    } catch (err) {
      notFound(ctx.res, `Cannot list directory: ${(err as Error).message}`)
    }
  })

  // ── Read file content ──────────────────────────────────────────────────
  router.get("/api/file/content", async (ctx) => {
    const filePath = ctx.query.path
    if (!filePath) {
      badRequest(ctx.res, "path query parameter is required")
      return
    }
    try {
      const abs = safePath(cwd, filePath)
      const st = await stat(abs)
      if (st.isDirectory()) {
        badRequest(ctx.res, "Path is a directory, not a file")
        return
      }
      if (st.size > MAX_FILE_BYTES) {
        badRequest(ctx.res, `File too large: ${st.size} bytes (max ${MAX_FILE_BYTES})`)
        return
      }
      const content = await readFile(abs, "utf8")
      ok(ctx.res, { path: filePath, content, size: st.size })
    } catch (err) {
      notFound(ctx.res, `Cannot read file: ${(err as Error).message}`)
    }
  })

  // ── File status (size, modified, isDir) ────────────────────────────────
  router.get("/api/file/status", async (ctx) => {
    const filePath = ctx.query.path
    if (!filePath) {
      badRequest(ctx.res, "path query parameter is required")
      return
    }
    try {
      const abs = safePath(cwd, filePath)
      const st = await stat(abs)
      ok(ctx.res, {
        path: filePath,
        size: st.size,
        isDirectory: st.isDirectory(),
        modifiedAt: st.mtime.toISOString(),
      })
    } catch (err) {
      notFound(ctx.res, `File not found: ${(err as Error).message}`)
    }
  })

  // ── Find files by glob pattern ─────────────────────────────────────────
  router.get("/api/find/file", async (ctx) => {
    const pattern = ctx.query.pattern ?? "**/*"
    try {
      const abs = safePath(cwd, ".")
      // Use the shared walk utility from @butterfly/core instead of a custom
      // recursive walker. walkWithDefaults skips node_modules, .git, dist, etc.
      const allFiles = await walkWithDefaults(abs)
      const matches = allFiles
        .filter((f) => {
          const relativePath = relative(abs, f)
          return matchGlob(relativePath, pattern)
        })
        .slice(0, 200)
      ok(ctx.res, { pattern, files: matches })
    } catch (err) {
      serverError(ctx.res, `Find failed: ${(err as Error).message}`)
    }
  })
}
