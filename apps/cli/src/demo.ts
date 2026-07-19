// Demo runner — sets up a tmp project, runs the Agent Loop with a scripted MockLLM that
// performs multi-tool ops (glob → read → write → text-end), prints structured logs.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AgentLoop, ModelRouter } from "@butterfly/agent"
import { COE, GPTTokenizer, SCE } from "@butterfly/context"
import { log } from "@butterfly/core"
import { ForgivingToolCallParser, MockLLMClient, textResponse, toolCallResponse } from "@butterfly/llm"
import { createSession, InMemorySessionStore } from "@butterfly/session"
import { globTool, readTool, ToolRegistry, writeTool } from "@butterfly/tools"

async function main() {
  const cwd = await mkdtemp(join(tmpdir(), "butterfly-demo-"))
  await mkdir(join(cwd, "src"), { recursive: true })
  await writeFile(join(cwd, "README.md"), "Demo fixture: a tiny project.\n", "utf8")
  await writeFile(join(cwd, "src", "hello.ts"), "export const hello = 'world'\n", "utf8")

  log("info", "demo.start", { cwd })

  const tok = new GPTTokenizer()
  await tok.count("warmup")
  const sce = new SCE(tok)
  const coe = new COE(tok)
  const router = new ModelRouter({
    tierMapping: { trivial: "m-triv", standard: "m-std", complex: "m-cplx", escalate: "m-esc" },
  })
  const registry = new ToolRegistry()
  registry.register(globTool)
  registry.register(readTool)
  registry.register(writeTool)
  const store = new InMemorySessionStore()

  const mock = new MockLLMClient([
    toolCallResponse([{ id: "g1", name: "glob", input: { pattern: "**/*.md" } }]),
    toolCallResponse([{ id: "r1", name: "read", input: { path: "README.md" } }]),
    toolCallResponse([
      {
        id: "w1",
        name: "write",
        input: { path: "FINDINGS.md", content: "Demo FINDINGS: 2 markdown files, 1 source file." },
      },
    ]),
    textResponse("Done."),
  ])

  const loop = new AgentLoop({ llm: mock, sce, coe, router, registry, store, parser: new ForgivingToolCallParser() })
  const session = createSession("demo-session", "build")
  const result = await loop.run({
    session,
    query: "Discover what's in this project and write findings.",
    cwd,
    maxSteps: 20,
  })

  log("info", "demo.done", {
    iterations: result.iterations,
    stopReason: result.stopReason,
    filesChanged: result.session.fileChanges.map((f) => f.path),
  })

  console.log("---- DEMO SUMMARY ----")
  console.log(
    JSON.stringify(
      {
        iterations: result.iterations,
        stopReason: result.stopReason,
        filesChanged: result.session.fileChanges,
        toolCalls: result.session.toolCalls.map((tc) => ({
          name: tc.name,
          ok: !tc.error,
          error: tc.error,
        })),
        onDisk: {
          FINDINGS: await readFile(join(cwd, "FINDINGS.md"), "utf8").catch(() => null),
        },
      },
      null,
      2,
    ),
  )

  await rm(cwd, { recursive: true, force: true })
}

main().catch((err) => {
  console.error("[demo] error:", err)
  process.exit(1)
})
