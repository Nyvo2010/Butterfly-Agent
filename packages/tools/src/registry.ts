import type { Tool, ToolKind } from "./types"

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: duplicate tool name: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): Tool[] {
    return Array.from(this.tools.values())
  }

  /**
   * Returns tools whose kind is in the allowed set. Used by Agent Loop (Phase C)
   * to materialize the available toolset for a given Mode.
   */
  listAllowed(kinds: ToolKind[]): Tool[] {
    const set = new Set(kinds)
    return this.list().filter((t) => set.has(t.kind))
  }

  size(): number {
    return this.tools.size
  }
}
