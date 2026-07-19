#!/usr/bin/env node
import { loadDotEnv } from "@butterfly/core"
import { runAgent } from "./run.js"
import { findWorkspaceRoot } from "./workspace-root.js"

interface ParsedArgs {
  task: string
  cwd: string
  maxSteps?: number
}

function parseArgs(argv: string[]): ParsedArgs {
  const kv: Record<string, string> = {}
  const positional: string[] = []
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2)
      if (v !== undefined) kv[k] = v
    } else {
      positional.push(a)
    }
  }
  return {
    task: positional.join(" ").trim(),
    cwd: kv.cwd ?? findWorkspaceRoot(process.cwd()),
    maxSteps: kv.maxSteps ? Number(kv.maxSteps) : undefined,
  }
}

async function main() {
  const wsRoot = findWorkspaceRoot(process.cwd())
  loadDotEnv(`${wsRoot}/.env`)
  const args = parseArgs(process.argv.slice(2))
  if (!args.task) {
    console.error(
      '[cli] usage: pnpm start "task description" [--cwd=/path] [--maxSteps=N]',
    )
    process.exit(2)
  }
  console.error(
    `[cli] starting. cwd=${args.cwd} task="${args.task.slice(0, 80)}"`,
  )
  try {
    const result = await runAgent({
      task: args.task,
      cwd: args.cwd,
      maxSteps: args.maxSteps,
    })
    const summary = {
      iterations: result.iterations,
      stopReason: result.stopReason,
      model: result.lastResolution.model,
      tier: result.lastResolution.tier,
      filesChanged: result.session.fileChanges.map((f) => `${f.path}(${f.kind})`),
      toolCalls: result.session.toolCalls.map((tc) => `${tc.name}${tc.error ? "[err]" : ""}`),
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
