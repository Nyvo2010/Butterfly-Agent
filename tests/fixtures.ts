/**
 * Test Fixtures for Butterfly Agent
 *
 * OpenCode-inspired: centralized fixtures for deterministic testing.
 * Provides factory functions for common test objects (sessions, messages,
 * tool calls, LLM responses, etc.).
 */

import type { LLMResponse, LLMUsage } from "../packages/llm/src/types.js"
import type { SessionState, ToolCallRecord } from "../packages/session/src/types.js"
import { createSession } from "../packages/session/src/types.js"

// ─── LLM Fixtures ────────────────────────────────────────────────────────────

export function zeroUsage(): LLMUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, usageAvailable: false }
}

export function sampleUsage(): LLMUsage {
  return { promptTokens: 150, completionTokens: 50, totalTokens: 200, usageAvailable: true }
}

export function textResponse(text: string, usage?: LLMUsage): LLMResponse {
  return { kind: "text", text, usage: usage ?? zeroUsage() }
}

export function toolCallResponse(
  calls: Array<{ id: string; name: string; input: unknown }>,
  usage?: LLMUsage,
): LLMResponse {
  return { kind: "tool_calls", calls, usage: usage ?? zeroUsage() }
}

// ─── Session Fixtures ────────────────────────────────────────────────────────

export function sampleSession(overrides?: Partial<SessionState>): SessionState {
  return {
    ...createSession("test-session", "build", "standard"),
    ...overrides,
  }
}

export function sessionWithMessages(messages: SessionState["messages"]): SessionState {
  const session = createSession("test-session", "build", "standard")
  return { ...session, messages }
}

// ─── Message Fixtures ────────────────────────────────────────────────────────

export function userMessage(content: string): SessionState["messages"][0] {
  return {
    id: `msg-user-${Date.now()}`,
    role: "user",
    content,
    timestamp: new Date().toISOString(),
  }
}

export function assistantMessage(content: string): SessionState["messages"][0] {
  return {
    id: `msg-assistant-${Date.now()}`,
    role: "assistant",
    content,
    timestamp: new Date().toISOString(),
  }
}

export function toolMessage(content: string, toolCallId: string): SessionState["messages"][0] {
  return {
    id: `msg-tool-${Date.now()}`,
    role: "tool",
    content,
    toolCallId,
    timestamp: new Date().toISOString(),
  }
}

// ─── Tool Call Fixtures ──────────────────────────────────────────────────────

export function toolCallRecord(name: string, overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: `tc-${name}-${Date.now()}`,
    name,
    input: {},
    result: { entries: [] },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  }
}
