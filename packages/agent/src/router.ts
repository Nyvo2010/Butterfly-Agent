import { log } from "@butterfly/core"
import type { Tier } from "@butterfly/session"

export interface TierMapping {
  trivial: string
  standard: string
  complex: string
  escalate: string
}

export interface RouterOptions {
  /** Concrete model IDs per tier. Required — callers must supply tier mapping. */
  tierMapping: TierMapping
  /** Cap on consecutive escalations before the loop stops. Default 3. */
  escalationLimit?: number
}

export interface ModelResolution {
  tier: Tier
  model: string
  escalationDepth: number
}

/**
 * Model Router — resolves which model to use for each agent step.
 *
 * Supports two modes:
 *   1. **Auto mode** (default, selectedModel === "auto" or undefined):
 *      Uses the tiered model mapping from butterfly config. Escalation moves
 *      up the tier chain (trivial → standard → complex → escalate).
 *   2. **Fixed mode** (selectedModel is a specific model string):
 *      Always uses that model regardless of tier. Escalation is a no-op.
 *      This is what the user gets when they pick a specific model from the UI.
 *
 * Mirrors OpenCode's model routing, where per-session model selection overrides
 * the tiered defaults.
 */
export class ModelRouter {
  private readonly mapping: TierMapping
  private readonly escalationLimit: number

  constructor(opts: RouterOptions) {
    this.mapping = opts.tierMapping
    this.escalationLimit = opts.escalationLimit ?? 3
  }

  /**
   * Resolve the model to use for the current step.
   * When `selectedModel` is provided and not "auto", it is returned directly
   * (ignoring tiers entirely). Otherwise, the tier mapping is used.
   */
  resolve(tier: Tier, depth: number, selectedModel?: string): ModelResolution {
    if (selectedModel && selectedModel !== "auto") {
      // Fixed model mode: always return the selected model, ignore tiers.
      return { tier, model: selectedModel, escalationDepth: depth }
    }
    // Auto mode: use tiered model mapping.
    return { tier, model: this.mapping[tier], escalationDepth: depth }
  }

  /**
   * Escalate to the next tier. Max depth = escalationLimit (default 3).
   * The depth parameter tracks ACTUAL escalation count (not derived from tier),
   * so that restored sessions don't immediately cap escalation.
   * escalationLimit=3 allows: standard→complex (depth 1), complex→escalate (depth 2), escalate+ (depth 3).
   *
   * When a fixed model is selected (selectedModel provided and not "auto"),
   * escalation is a no-op — the model stays the same regardless of failures.
   */
  escalate(
    currentTier: Tier,
    currentDepth: number,
    selectedModel?: string,
  ): { tier: Tier; depth: number; capped: boolean } {
    // Fixed model mode: escalation is a no-op.
    if (selectedModel && selectedModel !== "auto") {
      return { tier: currentTier, depth: currentDepth, capped: true }
    }

    if (currentDepth >= this.escalationLimit) {
      log("warn", "router.escalation_capped", {
        tier: currentTier,
        depth: currentDepth,
        limit: this.escalationLimit,
      })
      return { tier: currentTier, depth: currentDepth, capped: true }
    }
    const next: Tier =
      currentTier === "trivial"
        ? "standard"
        : currentTier === "standard"
          ? "complex"
          : currentTier === "complex"
            ? "escalate"
            : "escalate"
    log("info", "router.escalate", { from: currentTier, to: next, depth: currentDepth + 1 })
    return { tier: next, depth: currentDepth + 1, capped: false }
  }
}
