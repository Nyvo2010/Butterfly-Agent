/**
 * Bash tool — spawn-based shell execution with timeout, abort, workdir,
 * and output truncation. Mirrors OpenCode's ShellTool architecture:
 * streaming spawn instead of single-shot exec, workdir parameter,
 * timeout/abort support, and output size limits with file offload.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Tool } from "../types"

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes, matching OpenCode default
const MAX_OUTPUT_BYTES = 100_000 // ~100KB in-memory before truncation
const MAX_LINES = 200

const CRITICAL_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "SHELL",
  "BASH_ENV",
])

// Shell metacharacters that indicate command injection risk.
export const INJECTION_METACHAR_RE = /[;\n`]|\$\(|\$\{/

const DANGEROUS_PATTERNS = [
  /;\s*rm\s+/i,
  /;\s*rmdir\s+/i,
  /;\s*del(?:ete)?\s+/i,
  /\|\s*rm\s+/i,
  /&&\s*rm\s+/i,
  /\|\|\s*rm\s+/i,
  /(?<!\w)rm\s+-rf\s+(?:\/|~)/,
  /(?<!\w)rm\s+-rf\s*$/,
  /\$\{/,
  /\$\(/,
  /`[^`]+`/,
  /;\s*(?:shutdown|reboot|halt|poweroff)/i,
  /(?<!\w)sudo\s+/i,
  /(?<!\w)dd\s+/i,
  /:\(\s*\)\s*\{[^}]*\}:\s*;/,
  /(?<!\w)mkfs/,
  /(?<!\w)chmod\s+777/,
  /(?<!\w)\s+(?:chown|chgrp)\s+0\d+|root\b/i,
  />\s*\/dev\/(?:null|zero|random|urandom)/,
  /\|\s*base64\s+-d\s*\|\s*bash/i,
  /\|\s*bash\s+-c\s+/i,
  /node\s+-[eE]i\s+[\s\S]/,
  /eval\s+[\s\S]/,
  /exec\s+/i,
  /curl\s+[^\s]+\s+\|\s*bash/i,
  /python\s+-c\s+/i,
  /perl\s+-e\s+/i,
  /ruby\s+-e\s+/i,
]

export function isCommandSafe(command: string): boolean {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return false
  }
  return true
}

function mergeEnv(ctxEnv?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value
  }
  if (ctxEnv) {
    for (const [key, value] of Object.entries(ctxEnv)) {
      if (!CRITICAL_ENV_VARS.has(key)) merged[key] = value
    }
  }
  return merged
}

/**
 * Tail the last N lines up to maxBytes. OpenCode-compatible truncation.
 * Returns { text, cut } where cut=true means lines were dropped.
 */
function tail(text: string, maxLines: number, maxBytes: number): { text: string; cut: boolean } {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return { text, cut: false }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        // One line is bigger than maxBytes — take the suffix.
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return { text: out.join("\n"), cut: true }
}

/**
 * Spawn a child process and capture stdout/stderr with timeout and abort support.
 * Mirrors OpenCode's ChildProcess.spawn + stream pattern.
 */
function spawnCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{
  stdout: string
  stderr: string
  exitCode: number | null
  killed: boolean
  timedOut: boolean
}> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(command, {
      shell: true,
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let totalBytes = 0
    let killed = false
    let timedOut = false

    child.stdout?.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes <= MAX_OUTPUT_BYTES * 2) {
        stdoutChunks.push(chunk)
      }
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes <= MAX_OUTPUT_BYTES * 2) {
        stderrChunks.push(chunk)
      }
    })

    // Timeout
    const timer = setTimeout(() => {
      timedOut = true
      killed = true
      child.kill("SIGTERM")
      // Force kill after 3 seconds if still alive (matching OpenCode).
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL")
        }
      }, 3000).unref()
    }, timeoutMs)
    if (timer.unref) timer.unref()

    // Abort signal
    const onAbort = () => {
      killed = true
      child.kill("SIGTERM")
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL")
        }
      }, 3000).unref()
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    child.on("close", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)

      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code,
        killed,
        timedOut,
      })
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)

      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: `${err.message}\n${Buffer.concat(stderrChunks).toString("utf-8")}`,
        exitCode: 1,
        killed: false,
        timedOut: false,
      })
    })
  })
}

export const bashTool: Tool<{ stdout: string; stderr: string; exitCode: number }> = {
  name: "bash",
  description:
    "Run a shell command. Returns stdout, stderr, and exitCode. " +
    `Commands time out after a default ${DEFAULT_TIMEOUT_MS}ms. ` +
    "Use workdir to run in a different directory (instead of cd). " +
    "Output over 100KB is truncated; use grep/read tools for full inspection.",
  kind: "exec",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      timeout: {
        type: "number",
        description: `Optional timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`,
      },
      workdir: {
        type: "string",
        description: "The working directory to run the command in. Use this instead of cd.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const command = String(input.command ?? "")
    if (!command) return { kind: "err", message: "command is required" }

    if (!isCommandSafe(command)) {
      return { kind: "err", message: "Command contains dangerous patterns and was blocked." }
    }
    if (INJECTION_METACHAR_RE.test(command)) {
      return { kind: "err", message: "Command contains shell metacharacters and was blocked." }
    }

    const timeout =
      Number.isFinite(Number(input.timeout)) && Number(input.timeout) > 0
        ? Number(input.timeout)
        : DEFAULT_TIMEOUT_MS

    // Validate workdir against workspace roots to prevent escape.
    const rawWorkdir = typeof input.workdir === "string" && input.workdir ? input.workdir : ctx.cwd
    const workdir = resolve(rawWorkdir)
    if (ctx.workspaceRoots?.length) {
      const allowed = ctx.workspaceRoots.some(
        (root) => workdir === resolve(root) || workdir.startsWith(resolve(root) + "/"),
      )
      if (!allowed) {
        return {
          kind: "err",
          message: `access denied: workdir "${rawWorkdir}" is outside the workspace`,
        }
      }
    }

    const env = mergeEnv(ctx.env)

    try {
      const result = await spawnCommand(command, workdir, env, timeout, ctx.signal)

      let meta = ""
      if (result.timedOut) {
        meta += `\n\n<shell_metadata>Command terminated after exceeding timeout ${timeout}ms. If this command is expected to take longer, retry with a larger timeout value.</shell_metadata>`
      }
      if (result.killed && !result.timedOut) {
        meta += `\n\n<shell_metadata>Command was aborted.</shell_metadata>`
      }

      // Truncate output if too large, save full output to a temp file.
      let stdout = result.stdout
      const stdoutSize = Buffer.byteLength(stdout, "utf-8")
      let truncated = false

      if (stdoutSize > MAX_OUTPUT_BYTES) {
        truncated = true
        const tmpFile = join(tmpdir(), `butterfly-shell-${randomBytes(4).toString("hex")}.txt`)
        try {
          await mkdir(tmpdir(), { recursive: true })
          await writeFile(tmpFile, stdout, "utf-8")
          const tailed = tail(stdout, MAX_LINES, MAX_OUTPUT_BYTES)
          stdout = tailed.text
          if (truncated && tmpFile) {
            stdout = `...output truncated to ${MAX_LINES} lines / ${MAX_OUTPUT_BYTES} bytes...\nFull output saved to: ${tmpFile}\n\n${stdout}`
          }
        } catch {
          // Fallback: just tail without file save if tmp write fails.
          const tailed = tail(stdout, MAX_LINES, MAX_OUTPUT_BYTES)
          stdout = tailed.text
        }
      }

      if (!stdout && !result.stderr) stdout = "(no output)"

      return {
        kind: "ok",
        output: {
          stdout: stdout + meta,
          stderr: result.stderr,
          exitCode: result.exitCode ?? 1,
        },
      }
    } catch (err) {
      return { kind: "err", message: (err as Error).message ?? "bash failed" }
    }
  },
}
