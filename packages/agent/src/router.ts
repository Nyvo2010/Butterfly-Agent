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

export class ModelRouter {
  private readonly mapping: TierMapping
  private readonly escalationLimit: number

  constructor(opts: RouterOptions) {
    this.mapping = opts.tierMapping
    this.escalationLimit = opts.escalationLimit ?? 3
  }

  resolve(tier: Tier, depth: number): ModelResolution {
    return { tier, model: this.mapping[tier], escalationDepth: depth }
  }

  /**
   * Returns the next tier if escalation is possible; same tier if already at top.
   * MVP-SCOPE §7: escalation max depth = 2; we count the incoming depth
   * and refuse further escalation past the limit.
   */
  /**
   * Escalate to the next tier. Max depth = escalationLimit (default 3).
   * The depth parameter tracks ACTUAL escalation count (not derived from tier),
   * so that restored sessions don't immediately cap escalation.
   * escalationLimit=3 allows: standard→complex (depth 1), complex→escalate (depth 2), escalate+ (depth 3).
   */
  escalate(
    currentTier: Tier,
    currentDepth: number,
  ): { tier: Tier; depth: number; capped: boolean } {
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
