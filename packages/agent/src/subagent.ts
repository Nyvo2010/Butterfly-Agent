import { randomUUID } from "node:crypto"
import { log } from "@butterfly/core"
import type { Mode } from "@butterfly/session"
import type { AgentLoop, RunRequest, RunResult } from "./loop"
import { isIntermediateAssistantMessage } from "./loop"

/**
 * Maximum subagent nesting depth. Subagents at depth >= MAX_SUBAGENT_DEPTH
 * cannot spawn further subagents, preventing unbounded recursion.
 */
const MAX_SUBAGENT_DEPTH = 1

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
  /** Current nesting depth. Internal use — callers should not set this. */
  depth?: number
  /** Optional project bootstrap summary for subagent awareness. */
  bootstrapSummary?: string
}

export class Subagent {
  constructor(private readonly loop: AgentLoop) {}

  async spawn(opts: SpawnOptions): Promise<SubagentHandle> {
    const depth = opts.depth ?? 0
    if (depth >= MAX_SUBAGENT_DEPTH) {
      log("warn", "subagent.depth_limit", { depth, max: MAX_SUBAGENT_DEPTH })
      return {
        finalOutput: `Cannot spawn subagent: maximum depth of ${MAX_SUBAGENT_DEPTH} reached.`,
        filesChanged: [],
        success: false,
      }
    }

    log("info", "subagent.spawn", {
      task: opts.task.slice(0, 200),
      mode: opts.mode ?? "build",
      depth,
    })
    // Stateless: build a fresh ephemeral session per MVP-SCOPE §9.
    const id = `subagent-${randomUUID()}`
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
      subagentDepth: depth + 1,
      bootstrapSummary: opts.bootstrapSummary,
    }
    const result: RunResult = await this.loop.run(req)
    const finalOutput = extractFinalOutput(result.session.messages)
    const filesChanged = result.session.fileChanges.map((fc) => fc.path)
    // Consider it successful if no tool errors and stop reason is clean.
    const hadToolErrors = result.session.toolCalls.some((tc) => tc.error)
    const success = !hadToolErrors && result.stopReason === "no_tool_calls"
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

/**
 * Extract the final meaningful output from the assistant.
 * Skips intermediate "Using tools: ..." messages to find the actual response.
 */
function extractFinalOutput(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === "assistant") {
      // Skip intermediate messages (tool invocations and plan acknowledgments)
      // using the centralized predicate from loop.ts.
      if (isIntermediateAssistantMessage(m.content)) continue
      return m.content
    }
  }
  return ""
}
