import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, loadDotEnv, log } from "@butterfly/core"
import { afterEach, describe, expect, it } from "vitest"

describe("core / loadDotEnv", () => {
  let tmpDir: string

  it("parses a simple .env file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "core-test-"))
    writeFileSync(join(tmpDir, ".env"), "FOO=bar\nBAZ=qux\n")
    loadDotEnv(join(tmpDir, ".env"))
    expect(process.env.FOO).toBe("bar")
    expect(process.env.BAZ).toBe("qux")
  })

  it("ignores comments and blank lines", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "core-test-"))
    writeFileSync(join(tmpDir, ".env"), "# comment\n\nKEY=val\n")
    loadDotEnv(join(tmpDir, ".env"))
    expect(process.env.KEY).toBe("val")
  })

  it("handles quoted values", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "core-test-"))
    writeFileSync(join(tmpDir, ".env"), 'MSG="hello world"\n')
    loadDotEnv(join(tmpDir, ".env"))
    expect(process.env.MSG).toBe("hello world")
  })

  it("does not throw on missing file", () => {
    expect(() => loadDotEnv("/nonexistent/.env")).not.toThrow()
  })
})

describe("core / loadConfig", () => {
  const OLD_ENV = { ...process.env }

  afterEach(() => {
    process.env = { ...OLD_ENV }
  })

  it("reads LLM_API_KEY from env", () => {
    process.env.LLM_API_KEY = "test-key-123"
    const cfg = loadConfig()
    expect(cfg.llm.apiKey).toBe("test-key-123")
  })

  it("reads LLM_BASE_URL from env", () => {
    process.env.LLM_BASE_URL = "https://custom.api.com"
    const cfg = loadConfig()
    expect(cfg.llm.baseUrl).toBe("https://custom.api.com")
  })

  it("reads agent.logLevel with default", () => {
    delete process.env.AGENT_LOG_LEVEL
    const cfg = loadConfig()
    expect(cfg.agent.logLevel).toBe("info")
  })

  it("reads agent.maxSteps from env", () => {
    process.env.AGENT_MAX_STEPS = "15"
    const cfg = loadConfig()
    expect(cfg.agent.maxSteps).toBe(15)
  })

  it("reads debug config", () => {
    process.env.DEBUG = "true"
    process.env.DEBUG_NAMESPACE = "test:*"
    const cfg = loadConfig()
    expect(cfg.debug.enabled).toBe(true)
    expect(cfg.debug.namespace).toBe("test:*")
  })

  it("reads trace config", () => {
    process.env.TRACE_ENABLED = "true"
    process.env.TRACE_EXPORTER = "otlp"
    const cfg = loadConfig()
    expect(cfg.trace.enabled).toBe(true)
    expect(cfg.trace.exporter).toBe("otlp")
  })
})

describe("core / logger", () => {
  it("emits JSON lines to stdout", () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]))
    })
    log("info", "test.event", { key: "value" })
    spy.mockRestore()
    expect(lines.length).toBeGreaterThan(0)
    const parsed = JSON.parse(lines[0])
    expect(parsed.level).toBe("info")
    expect(parsed.message).toBe("test.event")
    if (parsed.context) {
      expect(parsed.context.key).toBe("value")
    }
  })

  it("emits errors to stderr", () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]))
    })
    log("error", "error.event", { msg: "oops" })
    spy.mockRestore()
    expect(lines.length).toBeGreaterThan(0)
    const parsed = JSON.parse(lines[0])
    expect(parsed.level).toBe("error")
    expect(parsed.message).toBe("error.event")
  })

  it("has timestamp in ISO format", () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]))
    })
    log("info", "ts.test", {})
    spy.mockRestore()
    const parsed = JSON.parse(lines[0])
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
