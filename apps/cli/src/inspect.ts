/**
 * apps/cli/src/inspect.ts
 *
 * Functional verification harness. Exercises every engine + the Agent Loop with
 * REAL filesystem data, REAL session state, and (optionally) the user's REAL LLM
 * via VercelAILLMClient. Logs every transition to stdout.
 *
 * Modes:
 *   - default                  → MockLLMClient (no real LLM traffic; tools still hit fs)
 *   - INSPECT_REAL_LLM=1       → VercelAILLMClient against process.env.LLM_BASE_URL
 *
 * Run examples:
 *   pnpm exec tsx apps/cli/src/inspect.ts
 *   INSPECT_REAL_LLM=1 BUTTERFLY_MODEL_TRIVIAL=open-mistral-7b \
 *     BUTTERFLY_MODEL_STANDARD=open-mistral-7b \
 *     BUTTERFLY_MODEL_COMPLEX=open-mistral-7b \
 *     BUTTERFLY_MODEL_ESCALATE=open-mistral-7b \
 *     pnpm exec tsx apps/cli/src/inspect.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AgentLoop, ModelRouter } from "@butterfly/agent"
import { COE, GPTTokenizer, SCE } from "@butterfly/context"
import { loadDotEnv } from "@butterfly/core"
import {
  type LLMClient,
  ForgivingToolCallParser,
  MockLLMClient,
  textResponse,
  toolCallResponse,
  VercelAILLMClient,
} from "@butterfly/llm"
import { createSession, InMemorySessionStore } from "@butterfly/session"
import type { Tool } from "@butterfly/tools"
import {
  bashTool,
  globTool,
  grepTool,
  listTool,
  patchTool,
  readTool,
  ToolRegistry,
  writeTool,
} from "@butterfly/tools"
import { findWorkspaceRoot } from "./workspace-root.js"

const DIV = "\n" + "=".repeat(79) + "\n"

async function section(title: string, body: () => Promise<void>) {
  process.stdout.write(`${DIV}  ${title}\n${DIV}`)
  await body()
}

// ─── SCE ─────────────────────────────────────────────────────────────────
async function inspectSCE(workspace: string) {
  await section(`SCE — Smart Context Engine (queries against REAL project root)`, async () => {
    const tokenizer = new GPTTokenizer()
    await tokenizer.count("warmup")
    const sce = new SCE(tokenizer)
    console.log(`[SCE.input]  cwd=${workspace}`)
    for (const query of ["router", "loop", "tools", "session", "context"]) {
      const slice = await sce.select(query, { cwd: workspace })
      const totalSnippetTokens = slice.fileSnippets.reduce((a, s) => a + s.tokens, 0)
      console.log(
        `[SCE.query="${query}"]  grepMatches=${slice.grepMatches.length}` +
          `  fileSnippets=${slice.fileSnippets.length}` +
          `  snippetTokens=${totalSnippetTokens}`,
      )
      // Print every grep match so the user can see what SCE actually found.
      // Truncate the displayed content but keep every match by file:line.
      const MATCH_PREVIEW = 100
      const matches = slice.grepMatches
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i]
        if (!m) continue
        const preview =
          m.content.length > MATCH_PREVIEW ? `${m.content.slice(0, MATCH_PREVIEW)}…` : m.content
        console.log(`  ↳ ${m.file}:${m.line}  ${preview}`)
      }
      for (const f of slice.fileSnippets) {
        console.log(`  → ${f.path} (${f.tokens} tokens, ${f.content.length} chars)`)
      }
    }
  })
}

// ─── COE ─────────────────────────────────────────────────────────────────
async function inspectCOE() {
  await section(
    `COE — Context Optimization Engine (realistic session, real transform)`,
    async () => {
      const tokenizer = new GPTTokenizer()
      await tokenizer.count("warmup")
      const coe = new COE(tokenizer)

      const state = createSession("inspect-coe-session", "build")
      state.messages = [
        {
          id: "m-sys",
          role: "system",
          content:
            "You are a Butterfly Agent in BUILD mode with read/write/bash/patch tools available.",
          timestamp: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "m-query",
          role: "user",
          content:
            "Read MVP-SCOPE.md, summarize its 4 sections in 3 plain-text bullets, and write to MVP-SUMMARY.md.",
          timestamp: "2024-01-01T00:00:00.010Z",
        },
        {
          id: "m-list-result",
          role: "tool",
          content: "AGENTS.md\nMVP-SCOPE.md\nREADME.md\npackage.json",
          toolCallId: "tc-list",
          timestamp: "2024-01-01T00:00:01.000Z",
        },
        {
          id: "m-read-result",
          role: "tool",
          content: "x".repeat(6_000),
          toolCallId: "tc-read",
          timestamp: "2024-01-01T00:00:01.500Z",
        },
        {
          id: "m-large-result",
          role: "tool",
          content: "y".repeat(2_500),
          toolCallId: "tc-large",
          timestamp: "2024-01-01T00:00:02.000Z",
        },
      ]
      state.toolCalls = [
        {
          id: "tc-list",
          name: "list",
          input: { path: "." },
          result: "AGENTS.md\nMVP-SCOPE.md",
          startedAt: "2024-01-01T00:00:01.000Z",
        },
        {
          id: "tc-read",
          name: "read",
          input: { path: "MVP-SCOPE.md" },
          result: "ok",
          startedAt: "2024-01-01T00:00:01.500Z",
        },
        {
          id: "tc-read",
          name: "read",
          input: { path: "MVP-SCOPE.md" },
          result: "ok (retry after escalation)",
          startedAt: "2024-01-01T00:00:01.700Z",
        },
      ]

      const beforeTokens = state.messages.reduce((a, m) => a + tokenizer.count(m.content), 0)
      console.log(
        `[COE.input]  messages=${state.messages.length}, toolCalls=${state.toolCalls.length}, totalTokens=${beforeTokens}`,
      )

      const optimized = await coe.optimize(state, {
        maxContextTokens: 4_000,
        toolMessageMaxTokens: 1_500,
      })

      const afterTokens = optimized.messages.reduce((a, m) => a + tokenizer.count(m.content), 0)
      const truncatedTool = Math.max(
        ...optimized.messages
          .filter((m) => m.role === "tool")
          .map((m) => tokenizer.count(m.content)),
        0,
      )
      const systemSurvived = optimized.messages[0]?.role === "system"

      console.log(
        `[COE.output] messages=${optimized.messages.length}, toolCalls=${optimized.toolCalls.length}, totalTokens=${afterTokens}`,
      )
      console.log(
        `[COE.effect] dedup toolCalls: ${state.toolCalls.length} → ${optimized.toolCalls.length}`,
      )
      console.log(`[COE.effect] toolMsg max-tokens after truncate: ${truncatedTool}`)
      console.log(`[COE.effect] system message preserved: ${systemSurvived}`)
      console.log(
        `[COE.effect] dropped oldest non-system message(s): ${state.messages.length - optimized.messages.length}`,
      )
    },
  )
}

// ─── Tools ───────────────────────────────────────────────────────────────
async function inspectTools() {
  await section(
    `Tools — all 7 tools against a REAL tmp fixture (read → write → patch → bash → grep → glob → list)`,
    async () => {
      const tmp = await mkdtemp(join(tmpdir(), "butterfly-inspect-"))
      await mkdir(join(tmp, "src"), { recursive: true })
      await writeFile(
        join(tmp, "README.md"),
        "# Test Fixture\n\nUsed by inspect.ts for the 7-tool exercise.\n",
      )
      await writeFile(join(tmp, "src", "hello.ts"), "export const hello = 'world'\n")
      await writeFile(join(tmp, "src", "goodbye.ts"), "export const bye = 'farewell'\n")
      await writeFile(
        join(tmp, "src", "compute.ts"),
        "export function add(a: number, b: number) { return a + b }\n",
      )
      console.log(`[Tools.input] tmp=${tmp}`)
      console.log(
        `[Tools.input] files: ${["README.md", "src/hello.ts", "src/goodbye.ts", "src/compute.ts"].join(", ")}`,
      )

      const ctx = { cwd: tmp }
      const cases: Array<{ tool: Tool<unknown>; input: Record<string, unknown>; note: string }> = [
        { tool: listTool, input: { path: "." }, note: "list tmp root" },
        { tool: globTool, input: { pattern: "**/*.ts" }, note: "glob all .ts files" },
        {
          tool: grepTool,
          input: { pattern: "export", path: "src" },
          note: "grep for 'export' under src/",
        },
        { tool: readTool, input: { path: "README.md" }, note: "read README.md" },
        {
          tool: writeTool,
          input: { path: "OUTPUT.md", content: "Hello from real write.\n" },
          note: "write NEW.md",
        },
        {
          tool: patchTool,
          input: { path: "src/hello.ts", oldString: "'world'", newString: "'butterfly'" },
          note: "patch hello.ts (1 substitution)",
        },
        { tool: bashTool, input: { command: "ls -la" }, note: "bash ls" },
      ]

      for (const c of cases) {
        const start = Date.now()
        const result = await c.tool.execute(c.input, ctx)
        const elapsed = Date.now() - start
        const summary =
          result.kind === "ok"
            ? JSON.stringify(result.output).slice(0, 220)
            : `ERROR: ${result.message}`
        console.log(`\n[Tools.exec] ${c.tool.name} [${c.tool.kind}]  — ${c.note}`)
        console.log(`  input  : ${JSON.stringify(c.input).slice(0, 120)}`)
        console.log(`  kind   : ${result.kind}    elapsed=${elapsed}ms`)
        console.log(`  output : ${summary}`)
      }

      console.log(`\n[Tools.onDisk — disk after all 7 writes]`)
      for (const f of [
        "README.md",
        "OUTPUT.md",
        "src/hello.ts",
        "src/goodbye.ts",
        "src/compute.ts",
      ]) {
        try {
          const c = await readFile(join(tmp, f), "utf8")
          console.log(
            `  ${f.padEnd(20)} ${c.length.toString().padStart(5)} chars  —  ${c.split("\n")[0]?.slice(0, 60)}`,
          )
        } catch {
          console.log(`  ${f.padEnd(20)} (missing)`)
        }
      }
      await rm(tmp, { recursive: true, force: true })
    },
  )
}

// ─── Agent Loop ──────────────────────────────────────────────────────────
async function inspectLoop(workspace: string, useReal: boolean) {
  const title = useReal
    ? "Loop — REAL Mistral LLM via VercelAILLMClient (BUTTERFLY_MODEL_TIER override)"
    : "Loop — MockLLMClient scripted (real fs tools, all step logs)"
  await section(title, async () => {
    const tokenizer = new GPTTokenizer()
    await tokenizer.count("warmup")
    const registry = new ToolRegistry()
    registry.register(listTool)
    registry.register(globTool)
    registry.register(grepTool)
    registry.register(readTool)
    registry.register(writeTool)
    registry.register(patchTool)
    registry.register(bashTool)
    const sce = new SCE(tokenizer)
    const coe = new COE(tokenizer)
    const router = new ModelRouter()
    const store = new InMemorySessionStore()

    let llm: LLMClient
    if (useReal) {
      llm = new VercelAILLMClient({
        apiKey: process.env.LLM_API_KEY ?? "",
        baseUrl: process.env.LLM_BASE_URL || undefined,
      })
    } else {
      llm = new MockLLMClient([
        toolCallResponse([{ id: "g1", name: "glob", input: { pattern: "**/*.md" } }]),
        toolCallResponse([{ id: "r1", name: "read", input: { path: "AGENTS.md" } }]),
        toolCallResponse([
          {
            id: "w1",
            name: "write",
            input: {
              path: "AGENTS-SUMMARY.md",
              content:
                "## AGENTS.md summary (from real inspect.ts run)\n\n" +
                "- YAGNI is strict: no premature abstraction\n" +
                "- Modular subsystems (SCE, COE, Router, Loop, Tools)\n" +
                "- Every subsystem must be independently removable\n",
            },
          },
        ]),
        textResponse("Loop completed: globbed *.md, read AGENTS.md, wrote AGENTS-SUMMARY.md."),
      ])
    }

    const loop = new AgentLoop({ llm, sce, coe, router, registry, store, parser: new ForgivingToolCallParser() })
    const t0 = Date.now()
    const result = await loop.run({
      session: createSession("inspect-loop-session", "build"),
      query:
        "List every markdown file at the project root, read AGENTS.md, and write AGENTS-SUMMARY.md with a 3-bullet plain-text summary.",
      cwd: workspace,
      maxSteps: 8,
    })
    const elapsed = Date.now() - t0

    console.log(`[Loop.input]  cwd=${workspace}, llm=${useReal ? "real" : "mock"}`)
    console.log(
      `[Loop.output] iterations=${result.iterations}, stopReason=${result.stopReason}, model=${result.lastResolution.model}, tier=${result.lastResolution.tier}, elapsedMs=${elapsed}`,
    )
    console.log(`[Loop.output] filesChanged=${JSON.stringify(result.session.fileChanges)}`)
    console.log(
      `[Loop.output] toolCalls=${result.session.toolCalls
        .map((tc) => `${tc.name}${tc.error ? "[err]" : ""}`)
        .join(", ")}`,
    )
    console.log(`[Loop.output] messageTurns=${result.session.messages.length}`)
    console.log(`[Loop.output] finalTier=${result.lastResolution.tier}`)
    console.log(`\n[Loop.onDisk] AGENTS-SUMMARY.md:`)
    try {
      const c = await readFile(join(workspace, "AGENTS-SUMMARY.md"), "utf8")
      console.log(c)
    } catch {
      console.log("  (no AGENTS-SUMMARY.md created)")
    }
  })
}

async function main() {
  const workspace = findWorkspaceRoot(process.cwd())
  loadDotEnv(`${workspace}/.env`)

  console.log(
    `[env]  LLM_API_KEY set? ${Boolean(process.env.LLM_API_KEY)} (length=${process.env.LLM_API_KEY?.length ?? 0})`,
  )
  console.log(`[env]  LLM_BASE_URL = ${process.env.LLM_BASE_URL ?? "<empty>"}`)
  console.log(
    `[env]  BUTTERFLY_MODEL_TIER  trivial=${process.env.BUTTERFLY_MODEL_TRIVIAL ?? "<default>"}  std=${process.env.BUTTERFLY_MODEL_STANDARD ?? "<default>"}  cplx=${process.env.BUTTERFLY_MODEL_COMPLEX ?? "<default>"}  esc=${process.env.BUTTERFLY_MODEL_ESCALATE ?? "<default>"}`,
  )
  console.log(`[env]  workspace = ${workspace}`)
  console.log(`[env]  INSPECT_REAL_LLM = ${process.env.INSPECT_REAL_LLM ?? "0"}`)

  await inspectSCE(workspace)
  await inspectCOE()
  await inspectTools()
  await inspectLoop(workspace, process.env.INSPECT_REAL_LLM === "1")

  if (process.env.INSPECT_REAL_LLM !== "1") {
    process.stdout.write(DIV)
    console.log("  To re-run with the REAL Mistral LLM, set:")
    console.log("    INSPECT_REAL_LLM=1 BUTTERFLY_MODEL_TRIVIAL=open-mistral-7b \\")
    console.log("      BUTTERFLY_MODEL_STANDARD=open-mistral-7b \\")
    console.log("      BUTTERFLY_MODEL_COMPLEX=open-mistral-7b \\")
    console.log("      BUTTERFLY_MODEL_ESCALATE=open-mistral-7b \\")
    console.log("      pnpm exec tsx apps/cli/src/inspect.ts")
    process.stdout.write(DIV)
  }
}

main().catch((err) => {
  console.error("[inspect] fatal:", err)
  process.exit(1)
})
