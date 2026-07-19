import type { Tool } from "../types"

// Imported lazily at execution time to avoid a circular dependency:
// @butterfly/tools → @butterfly/agent → @butterfly/tools.
// The AgentLoop reference is injected via the tool context.

export interface SubagentToolDeps {
  spawn: (task: string, cwd: string, mode?: string, maxSteps?: number) => Promise<{
    finalOutput: string
    filesChanged: string[]
    success: boolean
  }>
}

export function createSubagentTool(deps: SubagentToolDeps): Tool<{
  finalOutput: string
  filesChanged: string[]
  success: boolean
}> {
  return {
    name: "spawn_subagent",
    description:
      "Spawn a child agent to complete a task independently. Returns its final output, files changed, and success status.",
    kind: "delegate",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        mode: { type: "string", enum: ["plan", "build"] },
        maxSteps: { type: "number" },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const task = String(input.task ?? "")
      if (!task) return { kind: "err", message: "task is required" }
      const mode = String(input.mode ?? "build")
      if (mode !== "plan" && mode !== "build") {
        return { kind: "err", message: `invalid mode: ${mode}. Must be "plan" or "build".` }
      }
      const maxSteps = typeof input.maxSteps === "number" ? input.maxSteps : 8
      try {
        const result = await deps.spawn(task, ctx.cwd, mode, maxSteps)
        return { kind: "ok", output: result }
      } catch (err) {
        return { kind: "err", message: `subagent failed: ${(err as Error).message}` }
      }
    },
  }
}
