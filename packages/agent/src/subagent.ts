import { log } from "@butterfly/core"
import type { Mode } from "@butterfly/session"
import type { AgentLoop, RunRequest, RunResult } from "./loop"

/**
 * MVP-SCOPE §9: stateless subagent at depth=1.
 * It receives a task, runs the Agent Loop as an isolated child,
 * returns { finalOutput, filesChanged, success } of THAT run only.
 */
export interface SubagentHandle {
  finalOutput: string
  filesChanged: string[]
  success: boolean
}

export interface SpawnOptions {
  task: string
  cwd: string
  mode?: Mode
  maxSteps?: number
}

export class Subagent {
  constructor(private readonly loop: AgentLoop) {}

  async spawn(opts: SpawnOptions): Promise<SubagentHandle> {
    log("info", "subagent.spawn", { task: opts.task.slice(0, 200), mode: opts.mode ?? "build" })
    // Stateless: build a fresh ephemeral session per MVP-SCOPE §9.
    const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const req: RunRequest = {
      session: {
        id,
        mode: opts.mode ?? "build",
        tier: "trivial",
        messages: [
          {
            id: `m-${id}-seed`,
            role: "user",
            content: opts.task,
            timestamp: new Date().toISOString(),
          },
        ],
        toolCalls: [],
        fileChanges: [],
        readFiles: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      query: opts.task,
      cwd: opts.cwd,
      maxSteps: opts.maxSteps ?? 8,
    }
    const result: RunResult = await this.loop.run(req)
    const finalOutput = extractFinalOutput(result.session.messages)
    const filesChanged = result.session.fileChanges.map((fc) => fc.path)
    const success = result.stopReason === "no_tool_calls" || result.stopReason === "max_steps"
    log("info", "subagent.complete", {
      subagentId: id,
      iterations: result.iterations,
      stopReason: result.stopReason,
      filesChanged: filesChanged.length,
      success,
    })
    return { finalOutput, filesChanged, success }
  }
}

function extractFinalOutput(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === "assistant") {
      return m.content
    }
  }
  return ""
}
