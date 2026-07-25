import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, loadButterflyConfig } from "../core/src/butterfly-config"
import { loadConfig } from "../core/src/config"
import { loadDotEnv } from "../core/src/dotenv"
import { log, setLogLevel } from "../core/src/logger"

describe("@butterfly/core — config", () => {
  it("loadConfig throws when LLM_API_KEY is not set", () => {
    expect(() => loadConfig({})).toThrow("LLM_API_KEY is required")
  })

  it("loadConfig returns config with LLM_API_KEY", () => {
    const cfg = loadConfig({ LLM_API_KEY: "test-key" })
    expect(cfg.llm.apiKey).toBe("test-key")
  })

  it("loadConfig validates log level and falls back to info", () => {
    const cfg = loadConfig({ LLM_API_KEY: "k", AGENT_LOG_LEVEL: "invalid" })
    expect(cfg.agent.logLevel).toBe("info")
  })

  it("loadConfig parses valid log level", () => {
    const cfg = loadConfig({ LLM_API_KEY: "k", AGENT_LOG_LEVEL: "debug" })
    expect(cfg.agent.logLevel).toBe("debug")
  })

  it("loadConfig validates max steps", () => {
    const cfg1 = loadConfig({ LLM_API_KEY: "k", AGENT_MAX_STEPS: "0" })
    expect(cfg1.agent.maxSteps).toBe(20)
    const cfg2 = loadConfig({ LLM_API_KEY: "k", AGENT_MAX_STEPS: "5" })
    expect(cfg2.agent.maxSteps).toBe(5)
    const cfg3 = loadConfig({ LLM_API_KEY: "k", AGENT_MAX_STEPS: "not-a-number" })
    expect(cfg3.agent.maxSteps).toBe(20)
  })
})

describe("@butterfly/core — dotenv", () => {
  it("loadDotEnv returns 0 for nonexistent file", () => {
    const count = loadDotEnv("/nonexistent/path/.env")
    expect(count).toBe(0)
  })
})

describe("@butterfly/core — logger", () => {
  it("setLogLevel accepts valid levels", () => {
    setLogLevel("debug")
    setLogLevel("info")
    setLogLevel("warn")
    setLogLevel("error")
  })

  it("log does not throw", () => {
    setLogLevel("debug")
    expect(() => log("info", "test message")).not.toThrow()
    expect(() => log("debug", "test", { key: "value" })).not.toThrow()
    expect(() => log("error", "error", { err: new Error("test") })).not.toThrow()
  })
})

describe("@butterfly/core — butterfly-config", () => {
  it("DEFAULT_CONFIG is frozen", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true)
  })

  it("loadButterflyConfig validates cwd", () => {
    expect(() => loadButterflyConfig("")).toThrow("cwd must be a non-empty string")
    expect(() => loadButterflyConfig("/nonexistent/directory/path")).toThrow(
      "not a valid directory",
    )
  })
})
