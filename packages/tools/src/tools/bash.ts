import { exec } from "node:child_process"
import { promisify } from "node:util"
import type { Tool } from "../types"

const execAsync = promisify(exec)
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_BUFFER_BYTES = 10 * 1024 * 1024

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
    const maxDuration = Number(input.maxDuration ?? DEFAULT_TIMEOUT_MS)
    try {
      const result = await execAsync(command, {
        cwd: ctx.cwd,
        timeout: maxDuration,
        maxBuffer: MAX_BUFFER_BYTES,
        env: ctx.env ? { ...process.env, ...ctx.env } : process.env,
      })
      return { kind: "ok", output: { stdout: result.stdout, stderr: result.stderr, exitCode: 0 } }
    } catch (err) {
      const e = err as {
        stdout?: string
        stderr?: string
        code?: number
        message?: string
        killed?: boolean
      }
      if (typeof e.stdout === "string" || typeof e.code === "number") {
        return {
          kind: "ok",
          output: {
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? "",
            exitCode: typeof e.code === "number" ? e.code : 1,
          },
        }
      }
      return { kind: "err", message: e.message ?? "bash failed" }
    }
  },
}
