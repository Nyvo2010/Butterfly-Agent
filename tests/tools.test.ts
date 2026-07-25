import { describe, expect, it } from "vitest"
import { ToolRegistry } from "../packages/tools/src/registry"
import { bashTool } from "../packages/tools/src/tools/bash"
import { listTool } from "../packages/tools/src/tools/list"
import { readTool } from "../packages/tools/src/tools/read"
import { writeTool } from "../packages/tools/src/tools/write"
import { isPathInWorkspace } from "../packages/tools/src/types"

describe("@butterfly/tools — ToolRegistry", () => {
  it("registers tools and prevents duplicates", () => {
    const r = new ToolRegistry()
    r.register(readTool)
    expect(r.size()).toBe(1)
    expect(() => r.register(readTool)).toThrow("duplicate tool name")
  })

  it("get returns undefined for missing tool", () => {
    const r = new ToolRegistry()
    expect(r.get("nonexistent")).toBeUndefined()
  })

  it("has checks tool existence", () => {
    const r = new ToolRegistry()
    expect(r.has("read")).toBe(false)
    r.register(readTool)
    expect(r.has("read")).toBe(true)
  })

  it("list returns all tools", () => {
    const r = new ToolRegistry()
    r.register(readTool)
    r.register(listTool)
    expect(r.list()).toHaveLength(2)
  })

  it("listAllowed filters by kind", () => {
    const r = new ToolRegistry()
    r.register(readTool) // kind: "read"
    r.register(writeTool) // kind: "write"
    r.register(bashTool) // kind: "exec"

    const readOnly = r.listAllowed(["read"])
    expect(readOnly).toHaveLength(1)
    expect(readOnly[0].name).toBe("read")

    const readWrite = r.listAllowed(["read", "write"])
    expect(readWrite).toHaveLength(2)
  })

  it("remove deletes a tool", () => {
    const r = new ToolRegistry()
    r.register(readTool)
    expect(r.remove("read")).toBe(true)
    expect(r.remove("read")).toBe(false)
    expect(r.size()).toBe(0)
  })
})

describe("@butterfly/tools — isPathInWorkspace", () => {
  it("returns false for empty workspace roots", async () => {
    const result = await isPathInWorkspace("/tmp/test", [])
    expect(result).toBe(false)
  })
})
