/**
 * Butterfly Agent — ACP (Agent Client Protocol)
 *
 * This package provides an ACP-compatible agent server that wraps
 * Butterfly's AgentLoop. Any ACP-compatible client (CLI, TUI, IDE, web)
 * can connect to Butterfly through this standard protocol.
 *
 * Architecture:
 *   Client (ACP) ──JSON-RPC──→ Butterfly ACP Agent ←── Butterfly AgentLoop
 *
 * Usage:
 *   import { createButterflyACP } from "@butterfly/acp"
 *   import * as acpSdk from "@agentclientprotocol/sdk"
 *
 *   const { acpAgent } = createButterflyACP(acpSdk)
 *   acpAgent.connect(process.stdin, process.stdout)
 */

export type { ButterflyACPOptions } from "./butterfly-acp-agent"
export { createButterflyACP } from "./butterfly-acp-agent"
