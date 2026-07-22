/**
 * creative-skeleton-reuse — the reuse-verdict helper the decision engine consults per
 * wireframe element to decide reuse tightness before substituting.
 *
 * The v3 recast is scaffold-not-substance: creative_skeletons.elements[] carries the
 * competitor's WIREFRAME (zone × role × prominence). This helper turns one element into
 * a coarse reuse verdict the decision engine uses to shape its substitution — a
 * prominent element gets a tight, faithful substitution; a low-prominence element can
 * be adapted more loosely (or dropped). A cold ad's offer/price element ALWAYS gets a
 * `strip` verdict — the temperature-honest rule overrides prominence.
 *
 * Deterministic, stateless — no admin client, no DB, no LLM. The decision engine calls
 * this once per element and never persists the verdict (per-copy-section reuse is
 * computed at AUTHOR time, never stored — see docs/brain/tables/creative_skeletons.md
 * Wireframe redesign gotcha).
 *
 * See docs/brain/specs/decision-engine-substitution-supervisor.md · Phase 1
 * and docs/brain/specs/skeleton-agnostic-wireframe-redesign.md (introduces the
 * elements[] scaffold this helper reads from).
 */

/** The reuse tightness the decision engine uses to shape the substitution. */
export type ReuseVerdict = "reuse_tight" | "reuse_loose" | "optional" | "strip";

/** The subset of a skeleton element this helper needs. Mirrors the shape gated by
 *  `creative_skeletons_elements_shape_chk` (migration 20261124120000). */
export interface ReuseVerdictElement {
  zone: "header" | "hero" | "body" | "footer" | "cta";
  role: "hook" | "mechanism" | "proof" | "offer" | "risk_reversal" | "social_proof" | "price";
  prominence: number;
}

export interface ReuseVerdictCtx {
  temperature: "cold" | "warm" | "hot";
}

const PROMINENCE_TIGHT = 0.7;
const PROMINENCE_LOOSE = 0.3;

/** Compute the coarse reuse verdict for one wireframe element under one temperature.
 *
 *  Rules:
 *    1. cold + role ∈ (offer|price) → 'strip' (the temperature-honest rule).
 *    2. prominence ≥ 0.7 → 'reuse_tight' (a prominent slot must be faithfully substituted).
 *    3. prominence ≥ 0.3 → 'reuse_loose' (adaptable — tone can flex).
 *    4. prominence < 0.3 → 'optional'    (droppable / low-cost to omit).
 *
 *  A pure function. The skeleton-agnostic-wireframe-redesign spec's Phase 3 may enrich
 *  this signature (e.g. adding a vision-derived signal) — future callers should still
 *  work through this named export rather than reinventing the verdict inline.
 */
export function computeReuseVerdict(
  element: ReuseVerdictElement,
  ctx: ReuseVerdictCtx,
): ReuseVerdict {
  if (ctx.temperature === "cold" && (element.role === "offer" || element.role === "price")) {
    return "strip";
  }
  if (element.prominence >= PROMINENCE_TIGHT) return "reuse_tight";
  if (element.prominence >= PROMINENCE_LOOSE) return "reuse_loose";
  return "optional";
}
