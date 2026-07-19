import { log } from "@butterfly/core"
import type { Tier } from "@butterfly/session"

export interface TierMapping {
  trivial: string
  standard: string
  complex: string
  escalate: string
}

export interface RouterOptions {
  /** Concrete model IDs per tier. Exposed for flexibility; defaults below. */
  tierMapping: TierMapping
  /** Cap on consecutive escalations before the loop stops. Default 2 per §7. */
  escalationLimit?: number
}

export interface ModelResolution {
  tier: Tier
  model: string
  escalationDepth: number
}

const DEFAULT_TIER_MAPPING: TierMapping = {
  trivial: "anthropic:claude-haiku-4-5",
  standard: "anthropic:claude-sonnet-4-5",
  complex: "anthropic:claude-sonnet-4-5",
  escalate: "anthropic:claude-opus-4-1",
}

export class ModelRouter {
  private readonly mapping: TierMapping
  private readonly escalationLimit: number

  constructor(opts: Partial<RouterOptions> = {}) {
    // Allow per-tier model override via env (BUTTERFLY_MODEL_TRIVIAL / STANDARD / COMPLEX / ESCALATE).
    // Read inside the constructor — not at module load — so tests can mutate process.env
    // before instantiation and see the override.
    this.mapping = opts.tierMapping ?? {
      trivial: process.env.BUTTERFLY_MODEL_TRIVIAL ?? DEFAULT_TIER_MAPPING.trivial,
      standard: process.env.BUTTERFLY_MODEL_STANDARD ?? DEFAULT_TIER_MAPPING.standard,
      complex: process.env.BUTTERFLY_MODEL_COMPLEX ?? DEFAULT_TIER_MAPPING.complex,
      escalate: process.env.BUTTERFLY_MODEL_ESCALATE ?? DEFAULT_TIER_MAPPING.escalate,
    }
    this.escalationLimit = opts.escalationLimit ?? 2
  }

  resolve(tier: Tier, depth: number): ModelResolution {
    return { tier, model: this.mapping[tier], escalationDepth: depth }
  }

  /**
   * Returns the next tier if escalation is possible; same tier if already at top.
   * MVP-SCOPE §7: escalation max depth = 2; we count the incoming depth
   * and refuse further escalation past the limit.
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
