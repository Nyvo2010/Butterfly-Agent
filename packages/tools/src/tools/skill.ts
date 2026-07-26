import { discoverSkills, getAllSkills, getSkill } from "../skills"
import type { Tool, ToolContext, ToolResult } from "../types"

/**
 * Skill tool — loads a skill's instructions into context.
 * Corresponds to OpenCode's skill tool. The skill system discovers
 * SKILL.md files from .butterfly/skills/, .agents/skills/, and
 * ~/.butterfly/skills/.
 */
export function createSkillTool(cwd: string): Tool {
  // Eagerly discover skills on tool creation.
  discoverSkills(cwd)

  return {
    name: "skill",
    description:
      "Load a skill to get specialized instructions and workflows for a specific task. " +
      "Use this when a task matches an available skill's description.",
    kind: "read",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the skill to load (from available_skills)",
        },
      },
      required: ["name"],
    },
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const name = String(input.name ?? "")
      if (!name) return { kind: "err", message: "Skill name is required" }

      const skill = getSkill(name)
      if (!skill) {
        const available = getAllSkills()
          .map((s) => s.name)
          .join(", ")
        return {
          kind: "err",
          message: `Skill "${name}" not found. Available skills: ${available || "none"}`,
        }
      }

      const output = [
        `<skill_content name="${skill.name}">`,
        `# Skill: ${skill.name}`,
        "",
        skill.content,
        "",
        `Base directory for this skill: ${skill.location.replace(/\/SKILL\.md$/, "")}`,
        "</skill_content>",
      ].join("\n")

      return {
        kind: "ok",
        output,
      }
    },
  }
}
