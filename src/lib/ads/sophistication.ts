/**
 * sophistication — the pure, deterministic shelf-derived Schwartz-level detector Dahlia's
 * copy-author box session reads to write AT the market's sophistication level rather than
 * a level below it. Ships as part of the [[../../../docs/brain/specs/dahlia-five-frameworks-copy-skill]]
 * M2 layer over the M1 rubric SSOT ([[./copy-rubric]]).
 *
 * Consumers: `stockProduct` in [[./creative-agent]] threads `target_schwartz_level =
 * computeSophisticationLevel(shelf)` into Dahlia's per-creative box session as a session
 * input; the [[../../../.claude/skills/dahlia-copy-author]] contract names the field and
 * instructs Dahlia to "write at target_schwartz_level; NEVER below (target-1)."
 *
 * Inputs: the ranked competitor shelf `getProvenCompetitorAngles` in [[./creative-sourcing]]
 * returns for THIS product. NO DB, NO IO — the helper is pure so a unit test pins every
 * bucket without a mock. Empty shelf → 3 (safe solution-aware default; the M1 rubric's
 * midpoint sub-descriptor).
 */
import type { CompetitorAngle } from "./creative-sourcing";

/** The 5 Schwartz awareness levels the M1 rubric ([[./copy-rubric]] `SCHWARTZ_LEVELS_1_TO_5`)
 *  names — L1 UNAWARE → L5 MOST-AWARE. */
export type SchwartzLevel = 1 | 2 | 3 | 4 | 5;

/** Rule-based token buckets — deliberately narrow, deterministic proxies for each stage's
 *  most on-the-nose vocabulary. The spec pins these tokens explicitly; a future coach that
 *  widens the vocabulary should extend the arrays here and pin the new tokens in the tests. */
const L2_PROBLEM_TOKENS: readonly string[] = ["tired", "crash", "fog", "stress"];
const L3_SOLUTION_TOKENS: readonly string[] = ["clean energy", "focus support"];
const L4_MECHANISM_TOKENS: readonly string[] = ["adaptogen", "l-theanine", "ashwagandha"];
const L5_VERSUS_TOKENS: readonly string[] = ["vs coffee", "compared to", "instead of"];

function anyHit(haystack: string, needles: readonly string[]): boolean {
  for (const n of needles) if (haystack.includes(n)) return true;
  return false;
}

/** Classify one CompetitorAngle's `hook + mechanismClaim` at its HIGHEST-hit Schwartz level.
 *  The market has moved to the highest level any competitor is writing at; a lower-level hit
 *  is subsumed. */
export function classifyAngleSchwartzLevel(angle: CompetitorAngle): SchwartzLevel {
  const joined = `${angle.hook ?? ""} ${angle.mechanismClaim ?? ""}`.toLowerCase();
  if (anyHit(joined, L5_VERSUS_TOKENS)) return 5;
  if (anyHit(joined, L4_MECHANISM_TOKENS)) return 4;
  if (anyHit(joined, L3_SOLUTION_TOKENS)) return 3;
  if (anyHit(joined, L2_PROBLEM_TOKENS)) return 2;
  return 1;
}

/**
 * The modal (most-common) Schwartz level across the competitor shelf, clamped to [1..5].
 * On a tie, prefer the HIGHER level (the market has already heard the lower one, so writing
 * lower loses; harder-to-write-against wins).
 *
 * Empty shelf → 3 (safe solution-aware default; a product with no scouted competitors
 * is by definition not competing on a proven Schwartz-4 mechanism yet).
 */
export function computeSophisticationLevel(shelf: readonly CompetitorAngle[]): SchwartzLevel {
  if (!shelf || shelf.length === 0) return 3;

  const counts: Record<SchwartzLevel, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const angle of shelf) counts[classifyAngleSchwartzLevel(angle)] += 1;

  // Modal level, higher-wins tiebreak — iterate 5→1 so the first max we see is the highest.
  let best: SchwartzLevel = 1;
  let bestCount = -1;
  const levels: SchwartzLevel[] = [5, 4, 3, 2, 1];
  for (const lvl of levels) {
    if (counts[lvl] > bestCount) {
      best = lvl;
      bestCount = counts[lvl];
    }
  }
  return best;
}
