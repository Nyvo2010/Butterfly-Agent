import { spawn, type ChildProcess } from "node:child_process"
import type { Tool } from "../types"

interface BgEntry {
  process: ChildProcess
  startedAt: string
  command: string
  cwd: string
  stdout: string
  stderr: string
}

/**
 * Track active background processes so they can be inspected/terminated.
 * Module-scoped: shared across all agent runs in the same process.
 * For library use with concurrent loops, add isolation (e.g., per-run Map).
 */
const bgProcesses = new Map<string, BgEntry>()

export const backgroundBashTool: Tool<{ processId: string; pid: number }> = {
  name: "background_bash",
  description:
    "Run a shell command in the background. Returns a process ID. " +
    "Use background_status to check output and background_kill to stop it.",
  kind: "exec",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run in background." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const command = String(input.command ?? "")
    if (!command) return { kind: "err", message: "command is required" }
    const pid = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const entry: BgEntry = {
      process: null as unknown as ChildProcess, // set below
      startedAt: new Date().toISOString(),
      command,
      cwd: ctx.cwd,
      stdout: "",
      stderr: "",
    }

    const child = spawn(command, [], {
      cwd: ctx.cwd,
      shell: true,
      stdio: "pipe",
      env: ctx.env ? { ...process.env, ...ctx.env } : process.env,
    })

    entry.process = child

    // Accumulate stdout/stderr on the entry so status checks see live output.
    child.stdout?.on("data", (d: Buffer) => {
      entry.stdout += d.toString()
    })
    child.stderr?.on("data", (d: Buffer) => {
      entry.stderr += d.toString()
    })

    bgProcesses.set(pid, entry)

    return { kind: "ok", output: { processId: pid, pid: child.pid ?? 0 } }
  },
}

export const backgroundStatusTool: Tool<{
  processId: string
  running: boolean
  exitCode: number | null
  stdout: string
  stderr: string
}> = {
  name: "background_status",
  description: "Check the status and accumulated output of a background process.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      processId: { type: "string", description: "Process ID returned by background_bash." },
    },
    required: ["processId"],
    additionalProperties: false,
  },
  async execute(input, _ctx) {
    const processId = String(input.processId ?? "")
    if (!processId) return { kind: "err", message: "processId is required" }
    const entry = bgProcesses.get(processId)
    if (!entry) return { kind: "err", message: `No background process with id: ${processId}` }

    const running = entry.process.exitCode === null && entry.process.signalCode === null

    return {
      kind: "ok",
      output: {
        processId,
        running,
        exitCode: entry.process.exitCode ?? null,
        stdout: entry.stdout.slice(-50_000), // Truncate for context window.
        stderr: entry.stderr.slice(-10_000),
      },
    }
  },
}

export const backgroundKillTool: Tool<{ killed: boolean }> = {
  name: "background_kill",
  description: "Terminate a running background process by its process ID.",
  kind: "exec",
  inputSchema: {
    type: "object",
    properties: {
      processId: { type: "string", description: "Process ID returned by background_bash." },
    },
    required: ["processId"],
    additionalProperties: false,
  },
  async execute(input, _ctx) {
    const processId = String(input.processId ?? "")
    if (!processId) return { kind: "err", message: "processId is required" }
    const entry = bgProcesses.get(processId)
    if (!entry) return { kind: "err", message: `No background process with id: ${processId}` }
    entry.process.kill()
    bgProcesses.delete(processId)
    return { kind: "ok", output: { killed: true } }
  },
}
