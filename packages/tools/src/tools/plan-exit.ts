import type { Tool, ToolContext, ToolResult } from "../types"

/**
 * Plan exit tool — signals that the planning phase is complete and the
 * user should be prompted to switch to build mode for implementation.
 * Mirrors OpenCode's plan_exit tool exactly.
 */
export const planExitTool: Tool = {
  name: "plan_exit",
  description:
    "Call this tool when you have completed the planning phase and are ready to exit plan agent. " +
    "The system will ask the user if they want to switch to build mode to start implementing the plan.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      planSummary: {
        type: "string",
        description: "A brief summary of the completed plan for the user to review",
      },
    },
    required: ["planSummary"],
    additionalProperties: false,
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const planSummary = String(input.planSummary ?? "")

    // Ask the user if they want to switch to build mode.
    // The onAskUser callback handles the user prompt.
    if (ctx.onAskUser) {
      const answer = await ctx.onAskUser(
        `Plan complete: ${planSummary}\n\nSwitch to build mode to start implementing?`,
        ["Yes, switch to build mode", "No, continue planning"],
      )
      if (answer?.includes("switch")) {
        return {
          kind: "ok",
          output: "plan_exit: switching to build mode. The user has approved implementation.",
        }
      }
    }

    return {
      kind: "ok",
      output:
        "plan_exit: plan is complete. Awaiting user confirmation to switch to build mode. " +
        `Summary: ${planSummary}`,
    }
  },
}
