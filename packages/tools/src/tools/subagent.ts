import type { Tool } from "../types"

export interface SubagentToolDeps {
  spawn: (
    task: string,
    cwd: string,
    mode?: string,
    maxSteps?: number,
  ) => Promise<{
    finalOutput: string
    filesChanged: string[]
    success: boolean
  }>
  /** Valid mode values accepted by the agent configuration. If empty, all modes are accepted. */
  validModes?: string[]
}

export function createSubagentTool(deps: SubagentToolDeps): Tool<{
  finalOutput: string
  filesChanged: string[]
  success: boolean
}> {
  const validModes = deps.validModes?.length ? new Set(deps.validModes) : null

  return {
    name: "spawn_subagent",
    description:
      "Spawn a child agent to complete a task independently. Returns its final output, files changed, and success status.",
    kind: "delegate",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        mode: { type: "string" },
        maxSteps: { type: "number" },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const task = String(input.task ?? "")
      if (!task) return { kind: "err", message: "task is required" }
      const mode = String(input.mode ?? "")
      if (validModes && mode && !validModes.has(mode)) {
        return {
          kind: "err",
          message: `invalid mode: "${mode}". Must be one of: ${deps.validModes?.join(", ") ?? ""}`,
        }
      }
      const rawMaxSteps = typeof input.maxSteps === "number" ? input.maxSteps : undefined
      let maxSteps = 8
      if (rawMaxSteps !== undefined) {
        if (!Number.isFinite(rawMaxSteps) || rawMaxSteps <= 0) {
          return {
            kind: "err",
            message: `maxSteps must be a finite positive number, got ${rawMaxSteps}`,
          }
        }
        if (rawMaxSteps > 50) {
          return {
            kind: "err",
            message: `maxSteps cannot exceed 50, got ${rawMaxSteps}`,
          }
        }
        maxSteps = Math.floor(rawMaxSteps)
      }
      try {
        const result = await deps.spawn(task, ctx.cwd, mode || undefined, maxSteps)
        return { kind: "ok", output: result }
      } catch (err) {
        return { kind: "err", message: `subagent failed: ${(err as Error).message}` }
      }
    },
  }
}
