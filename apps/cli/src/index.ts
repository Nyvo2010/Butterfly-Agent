#!/usr/bin/env node
import { loadConfig, loadDotEnv } from "@butterfly/core"
import { runAgent } from "./run.js"
import { findWorkspaceRoot } from "./workspace-root.js"

interface ParsedArgs {
  task: string
  cwd: string
  mockLLM: boolean
  maxSteps?: number
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>()
  const kv: Record<string, string> = {}
  const positional: string[] = []
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2)
      if (v === undefined) flags.add(k)
      else kv[k] = v
    } else {
      positional.push(a)
    }
  }
  // Default cwd to the pnpm workspace root rather than the package directory so that
  // tools see the full project tree when invoked via `pnpm --filter @butterfly/cli`.
  const cfg = loadConfig()
  return {
    task: positional.join(" ").trim(),
    cwd: kv.cwd ?? findWorkspaceRoot(process.cwd()),
    mockLLM: flags.has("mock") || !cfg.llm.apiKey,
    maxSteps: kv.maxSteps ? Number(kv.maxSteps) : undefined,
  }
}

async function main() {
  // Run before parseArgs so file-loaded env is visible during arg parsing.
  // pnpm --filter changes cwd to apps/cli, so resolve the workspace root first and load
  // the project's .env from there — loadDotEnv defaults to cwd-relative ".env" otherwise.
  const wsRoot = findWorkspaceRoot(process.cwd())
  loadDotEnv(`${wsRoot}/.env`)
  const args = parseArgs(process.argv.slice(2))
  if (!args.task) {
    console.error(
      '[cli] usage: pnpm start "task description" [--mock] [--cwd=/path] [--maxSteps=N]',
    )
    process.exit(2)
  }
  console.error(
    `[cli] starting. cwd=${args.cwd} task="${args.task.slice(0, 80)}" mockLLM=${args.mockLLM}`,
  )
  try {
    const { result, usedMock } = await runAgent({
      task: args.task,
      cwd: args.cwd,
      mockLLM: args.mockLLM,
      maxSteps: args.maxSteps,
    })
    const summary = {
      iterations: result.iterations,
      stopReason: result.stopReason,
      model: result.lastResolution.model,
      tier: result.lastResolution.tier,
      filesChanged: result.session.fileChanges.map((f) => `${f.path}(${f.kind})`),
      toolCalls: result.session.toolCalls.map((tc) => `${tc.name}${tc.error ? "[err]" : ""}`),
      usedMock,
    }
    console.error(`[cli] result ${JSON.stringify(summary, null, 0)}`)
    console.log(JSON.stringify(summary))
    process.exit(summary.toolCalls.some((c) => c.endsWith("[err]")) ? 1 : 0)
  } catch (err) {
    console.error("[cli] error:", err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
