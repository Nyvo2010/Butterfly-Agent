#!/usr/bin/env node
/**
 * Butterfly ACP server — stdio entry point.
 *
 * Speaks the Agent Client Protocol (JSON-RPC over ndjson on stdio), so any
 * ACP-compatible client (IDE, CLI, TUI) can drive Butterfly:
 *
 *   pnpm --filter @butterfly/acp-app dev
 *
 * or as a bin:
 *
 *   butterfly-acp
 *
 * Wires the shared ServerApp (via @butterfly/acp's createButterflyACP) to the
 * ACP SDK's AgentSideConnection. Works with any ACP client, e.g. the official
 * `acp` CLI:  acp run "butterfly-acp" -- "explain this repo"
 */

import { Readable, Writable } from "node:stream"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { createButterflyACP } from "@butterfly/acp"
import { log } from "@butterfly/core"

// Convert node stdio streams to web streams (the SDK's ndJsonStream expects them).
// The SDK's stream types use Uint8Array<ArrayBufferLike>; Node's toWeb returns
// a slightly narrower type, so we cast through the SDK's expected shape.
const stdoutStream = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
const stdinStream = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
const stream = ndJsonStream(stdoutStream, stdinStream)

new AgentSideConnection((conn) => createButterflyACP(conn), stream)

log("info", "acp_app.started")

// Keep the process alive; the connection owns the stdio streams.
process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
