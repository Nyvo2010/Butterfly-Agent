import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Butterfly Skill System.
 *
 * Skills are markdown files (SKILL.md) that contain specialized instructions
 * for the agent. They are discovered from:
 * 1. .butterfly/skills/ directory (project-local)
 * 2. ~/.butterfly/skills/ directory (global)
 * 3. .agents/skills/ directory (OpenCode-compatible)
 *
 * Each skill file has YAML-like frontmatter:
 *   ---
 *   name: my-skill
 *   description: What this skill does
 *   ---
 *   Skill instructions here...
 *
 * Inspired by OpenCode's skill system.
 */

export interface SkillInfo {
  name: string
  description?: string
  location: string
  content: string
}

interface SkillState {
  skills: Map<string, SkillInfo>
  dirs: Set<string>
}

let state: SkillState | null = null

/**
 * Discover and load all skills from configured directories.
 */
export function discoverSkills(cwd: string): SkillInfo[] {
  if (state) return Array.from(state.skills.values())

  state = { skills: new Map(), dirs: new Set() }

  const dirs = [
    join(cwd, ".butterfly", "skills"),
    join(cwd, ".agents", "skills"),
    join(homedir(), ".butterfly", "skills"),
  ]

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    state.dirs.add(dir)
    scanDirectory(dir, state)
  }

  return Array.from(state.skills.values())
}

function scanDirectory(dir: string, skState: SkillState): void {
  try {
    walkSkillDir(skState, dir)
  } catch {
    // Directory not readable — skip
  }
}

function walkSkillDir(skState: SkillState, currentDir: string, depth = 0): void {
  if (depth > 3) return // Guard against deep recursion

  let entries: string[]
  try {
    entries = readdirSync(currentDir)
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry)
    // biome-ignore lint/suspicious/noExplicitAny: statSync return type
    let st: any
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }

    if (st.isDirectory()) {
      walkSkillDir(skState, fullPath, depth + 1)
    } else if (entry === "SKILL.md") {
      loadSkillFile(fullPath, skState)
    }
  }
}

function loadSkillFile(filePath: string, skState: SkillState): void {
  try {
    const raw = readFileSync(filePath, "utf8")
    const parsed = parseSkillMarkdown(raw, filePath)
    if (!parsed) return

    // Allow project skills to override global ones.
    skState.skills.set(parsed.name, parsed)
  } catch {
    // Skip unreadable files
  }
}

function parseSkillMarkdown(raw: string, location: string): SkillInfo | null {
  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!frontmatterMatch) return null

  const frontmatter = frontmatterMatch[1]
  const content = frontmatterMatch[2].trim()

  // Parse YAML-like frontmatter (simplified).
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  if (!nameMatch) return null

  const name = nameMatch[1].trim()
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
  const description = descMatch ? descMatch[1].trim() : undefined

  return { name, description, location, content }
}

/**
 * Get a skill by name.
 */
export function getSkill(name: string): SkillInfo | undefined {
  if (!state) return undefined
  return state.skills.get(name)
}

/**
 * Get all available skills.
 */
export function getAllSkills(): SkillInfo[] {
  if (!state) return []
  return Array.from(state.skills.values())
}

/**
 * Format the skill list for the system prompt (verbose mode).
 */
export function formatSkillsForPrompt(skills: SkillInfo[]): string {
  const described = skills.filter((s) => s.description)
  if (described.length === 0) return ""

  return [
    "<available_skills>",
    ...described
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (s) =>
          `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.location}</location>\n  </skill>`,
      ),
    "</available_skills>",
  ].join("\n")
}

/**
 * Reset the skill cache (e.g., after file changes).
 */
export function resetSkills(): void {
  state = null
}
