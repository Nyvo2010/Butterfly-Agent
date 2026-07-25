import { exec } from "node:child_process"
import { promisify } from "node:util"
import type { Tool } from "../types"

const execAsync = promisify(exec)
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_BUFFER_BYTES = 10 * 1024 * 1024

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
// Allows: pipes (|), flags (-x), quotes, spaces, paths, env vars ($VAR),
// and command chaining (&&, ||) for legitimate multi-step workflows.
// Blocks only: command separators (;), newlines, command substitution ($(), ``),
// variable expansion (${}). Dangerous uses of && and || are caught by
// DANGEROUS_PATTERNS (e.g., && rm -rf /).
// Combined with DANGEROUS_PATTERNS for defense-in-depth.
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

function mergeEnv(ctxEnv?: Record<string, string>): Record<string, string> | undefined {
  if (!ctxEnv || Object.keys(ctxEnv).length === 0) return undefined
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value
  }
  for (const [key, value] of Object.entries(ctxEnv)) {
    if (!CRITICAL_ENV_VARS.has(key)) {
      merged[key] = value
    }
  }
  return merged
}

export const bashTool: Tool<{ stdout: string; stderr: string; exitCode: number }> = {
  name: "bash",
  description:
    "Run a shell command. Returns stdout, stderr, and exitCode. Times out after maxDuration ms (default 30000).",
  kind: "exec",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      maxDuration: { type: "number" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const command = String(input.command ?? "")
    if (!command) return { kind: "err", message: "command is required" }
    // Always check dangerous patterns regardless of shell metacharacters.
    // Previously, commands matching SAFE_COMMAND_RE (e.g., "rm -rf /") bypassed
    // the dangerous pattern check, creating a security gap.
    if (!isCommandSafe(command)) {
      return { kind: "err", message: "Command contains dangerous patterns and was blocked." }
    }
    // Additionally check for command injection metacharacters
    // (separators, chaining, substitution) that indicate injection risk
    // even if no known dangerous patterns match.
    if (INJECTION_METACHAR_RE.test(command)) {
      return { kind: "err", message: "Command contains shell metacharacters and was blocked." }
    }
    const rawDuration = Number(input.maxDuration ?? DEFAULT_TIMEOUT_MS)
    // Validate: reject non-positive, NaN, or Infinity values.
    const maxDuration =
      Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : DEFAULT_TIMEOUT_MS
    const env = mergeEnv(ctx.env)
    try {
      const result = await execAsync(command, {
        cwd: ctx.cwd,
        timeout: maxDuration,
        maxBuffer: MAX_BUFFER_BYTES,
        env: env ?? process.env,
      })
      return { kind: "ok", output: { stdout: result.stdout, stderr: result.stderr, exitCode: 0 } }
    } catch (err) {
      const e = err as {
        stdout?: string
        stderr?: string
        code?: number
        signal?: string
        message?: string
        killed?: boolean
      }
      if (
        typeof e.stdout === "string" ||
        typeof e.stderr === "string" ||
        typeof e.code === "number" ||
        e.signal
      ) {
        return {
          kind: "ok",
          output: {
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? "",
            exitCode: typeof e.code === "number" ? e.code : e.signal ? -1 : 1,
          },
        }
      }
      return { kind: "err", message: e.message ?? "bash failed" }
    }
  },
}
