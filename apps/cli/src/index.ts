#!/usr/bin/env node
import { loadDotEnv } from "@butterfly/core"
import { FileSystemSessionStore } from "@butterfly/session"
import { runAgent } from "./run.js"
import { findWorkspaceRoot } from "./workspace-root.js"

interface ParsedArgs {
  task: string
  cwd: string
  maxSteps?: number
  resumeSessionId?: string
  listSessions?: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const kv: Record<string, string> = {}
  const positional: string[] = []
  const flags = new Set<string>()
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eqIdx = a.indexOf("=")
      if (eqIdx >= 0) {
        kv[a.slice(2, eqIdx)] = a.slice(eqIdx + 1)
      } else {
        flags.add(a.slice(2))
      }
    } else {
      positional.push(a)
    }
  }
  return {
    task: positional.join(" ").trim(),
    cwd: kv.cwd ?? findWorkspaceRoot(process.cwd()),
    maxSteps: kv.maxSteps ? Number(kv.maxSteps) : undefined,
    resumeSessionId: kv.resume,
    listSessions: flags.has("list-sessions"),
  }
}

async function main() {
  const wsRoot = findWorkspaceRoot(process.cwd())
  loadDotEnv(`${wsRoot}/.env`)
  const args = parseArgs(process.argv.slice(2))

  // --list-sessions: show all saved sessions and exit.
  if (args.listSessions) {
    const store = new FileSystemSessionStore()
    const sessions = await store.list()
    if (sessions.length === 0) {
      console.log("No saved sessions.")
    } else {
      console.log(`Saved sessions (${sessions.length}):`)
      for (const s of sessions) {
        console.log(`  ${s.id}  ${s.updatedAt}`)
      }
    }
    process.exit(0)
  }

  if (!args.task && !args.resumeSessionId) {
    console.error(
      '[cli] usage: pnpm start "task description" [--cwd=/path] [--maxSteps=N] [--resume=<sessionId>] [--list-sessions]',
    )
    process.exit(2)
  }

  console.error(
    `[cli] starting. cwd=${args.cwd} task="${(args.task || "(resume)").slice(0, 80)}" resume=${args.resumeSessionId ?? "no"}`,
  )
  try {
    const result = await runAgent({
      task: args.task || "(continue previous session)",
      cwd: args.cwd,
      maxSteps: args.maxSteps,
      resumeSessionId: args.resumeSessionId,
    })
    const summary = {
      sessionId: result.session.id,
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
