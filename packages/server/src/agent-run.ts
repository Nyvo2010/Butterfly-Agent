/**
 * Session agent run orchestration — extracted from session routes.
 *
 * Owns the prompt → agent loop → persistence → run-state lifecycle so HTTP
 * routes stay thin and ACP can reuse the same path later.
 */

import type { AgentFactoryResult } from "@butterfly/agent"
import { type AskUserCallback, permissionCategoryForTool } from "@butterfly/agent"
import type { SessionState } from "@butterfly/session"
import type { ServerApp } from "./app"
import { requestPermission } from "./routes/permission"

export interface RunSessionPromptOptions {
  sessionId: string
  prompt: string
  maxSteps?: number
  /** Per-request temperature override passed to the LLM. */
  temperature?: number
  /** When true (default), return immediately and run in the background. */
  async?: boolean
}

export interface RunSessionPromptResult {
  sessionId: string
  status: "running" | "completed" | "aborted" | "error"
  iterations?: number
  stopReason?: string
  model?: string
  tier?: string
  usage?: SessionState["usage"]
  fileChanges?: Array<{ path: string; kind: string }>
  toolCalls?: Array<{ name: string; error?: string }>
  error?: string
}

function createAskUserHandler(app: ServerApp, sessionId: string): AskUserCallback {
  return (question, options, context) => {
    const tool = context?.tool ?? "ask_user"
    const category = context?.category ?? permissionCategoryForTool(tool)
    return requestPermission(app, sessionId, tool, question, options, category)
  }
}

async function executeRun(
  app: ServerApp,
  sessionId: string,
  session: SessionState,
  query: string,
  maxSteps: number | undefined,
  abort: AbortController,
  temperature?: number,
): Promise<RunSessionPromptResult> {
  const previousMessageCount = session.messages.length
  let agent: AgentFactoryResult | undefined
  try {
    agent = await app.createAgent({
      sessionId,
      onAskUser: createAskUserHandler(app, sessionId),
    })

    const sceOpts = app.butterflyConfig.butterfly?.sce
    const coeOpts = app.butterflyConfig.butterfly?.coe

    // Model-aware context budget: explicit config wins, otherwise derive from
    // the model's catalog context window (small-model friendly fallback 8000).
    const configuredBudget = coeOpts?.maxContextTokens
    const resolvedModel =
      session.selectedModel && session.selectedModel !== "auto"
        ? session.selectedModel
        : (app.butterflyConfig.model ?? "")
    const maxContextTokens =
      configuredBudget ??
      (resolvedModel ? await app.providerService.contextBudgetFor(resolvedModel, 8000) : 8000)

    const result = await agent.loop.run({
      session,
      query,
      cwd: app.cwd,
      maxSteps: maxSteps ?? app.butterflyConfig.butterfly?.maxSteps ?? 20,
      maxContextTokens,
      toolMessageMaxTokens: coeOpts?.toolMessageMaxTokens,
      signal: abort.signal,
      temperature,
      sceOptions: sceOpts
        ? {
            maxFiles: sceOpts.maxFiles,
            maxTokensPerFile: sceOpts.maxTokensPerFile,
            maxGrepResults: sceOpts.maxGrepResults,
            topFiles: sceOpts.topFiles,
          }
        : undefined,
      bootstrapSummary: agent.bootstrapSummary || undefined,
    })

    await app.sessionManager.save(result.session, { previousMessageCount })

    if (abort.signal.aborted) {
      app.runState.abort(sessionId, abort)
      return {
        sessionId: result.session.id,
        status: "aborted",
        iterations: result.iterations,
        stopReason: "aborted",
        model: result.lastResolution.model,
        tier: result.lastResolution.tier,
        usage: result.session.usage,
        fileChanges: result.session.fileChanges.map((f) => ({ path: f.path, kind: f.kind })),
        toolCalls: result.session.toolCalls.map((t) => ({ name: t.name, error: t.error })),
      }
    }

    app.runState.complete(
      sessionId,
      {
        iterations: result.iterations,
        stopReason: result.stopReason,
        model: result.lastResolution.model,
        tier: result.lastResolution.tier,
        query,
      },
      abort,
    )

    return {
      sessionId: result.session.id,
      status: "completed",
      iterations: result.iterations,
      stopReason: result.stopReason,
      model: result.lastResolution.model,
      tier: result.lastResolution.tier,
      usage: result.session.usage,
      fileChanges: result.session.fileChanges.map((f) => ({ path: f.path, kind: f.kind })),
      toolCalls: result.session.toolCalls.map((t) => ({ name: t.name, error: t.error })),
    }
  } catch (err) {
    const message = (err as Error).message
    app.runState.error(sessionId, message, abort)
    return { sessionId, status: "error", error: message }
  } finally {
    // Resolve + drop any pending permission requests — the run is over, so
    // lingering HITL prompts would otherwise sit until their 5-min timeout.
    app.permissionStore.clearForSession(sessionId)
    // Clear the persisted active-run marker.
    try {
      const current = await app.sessionManager.load(sessionId)
      if (current?.activeRun) {
        await app.sessionManager.save({ ...current, activeRun: undefined })
      }
    } catch {
      // Non-fatal.
    }
    if (agent) await agent.dispose()
  }
}

/**
 * Run the agent for a session prompt. By default runs asynchronously and
 * returns immediately with status "running".
 */
export async function runSessionPrompt(
  app: ServerApp,
  opts: RunSessionPromptOptions,
): Promise<RunSessionPromptResult> {
  const { sessionId, prompt, maxSteps, temperature } = opts
  const runAsync = opts.async !== false

  let session = await app.sessionManager.load(sessionId)
  if (!session) {
    session = await app.sessionManager.create({ id: sessionId })
  }

  const model =
    session.selectedModel && session.selectedModel !== "auto"
      ? session.selectedModel
      : (app.butterflyConfig.model ?? "default")

  const { abort } = app.runState.start(sessionId, {
    query: prompt,
    model,
    tier: session.tier,
  })

  // Persist an active-run marker so a server restart can detect interrupted
  // runs and report an honest status (see RunStateManager.recoverFromStore).
  try {
    await app.sessionManager.save({
      ...session,
      activeRun: { startedAt: new Date().toISOString(), query: prompt, model, tier: session.tier },
    })
  } catch {
    // Non-fatal — the marker is best-effort recovery metadata.
  }

  if (runAsync) {
    void executeRun(app, sessionId, session, prompt, maxSteps, abort, temperature).catch((err) => {
      app.runState.error(sessionId, (err as Error).message, abort)
    })
    return { sessionId, status: "running" }
  }

  return executeRun(app, sessionId, session, prompt, maxSteps, abort, temperature)
}
