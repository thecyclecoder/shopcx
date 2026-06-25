/**
 * spec-phase-provenance — the trust boundary for "is this phase done?"
 *
 * After [[../../docs/brain/specs/spec-status-phase-pr-provenance]], the ground truth for a shipped phase is
 * `phase_states[i].pr` + `merge_sha`, not `phase_states[i].status` alone. The merge hook
 * ([[applyMergedBuildEffects]]) is the only authoritative writer of `pr` — a director-emitted phase flip,
 * an old reconciler pass, or a hand-applied status sync can leave a phase `status='shipped'` with NO `pr`,
 * which is **drift suspect**, not done.
 *
 * Every director lane that reads "is this phase / card shipped?" calls into here. Centralising the rule
 * keeps the four lanes (escort, groom, init, spec-status executor) consistent and the audit cheap:
 * grep for `phaseHasProvenance` / `isCardFullyShippedWithProvenance` to see every gated read.
 *
 * Implements [[../../docs/brain/specs/director-trust-phase-pr-provenance]] Phase 1.
 */
import type { SpecCard, SpecPhase } from "@/lib/brain-roadmap";

/** True iff this phase's `shipped` status is backed by a merge-hook stamp (a PR # tag). */
export function phaseHasProvenance(p: Pick<SpecPhase, "status" | "pr">): boolean {
  return p.status === "shipped" && (p.pr ?? null) !== null;
}

/** Phases the card carries that are tagged `shipped` but lack a `pr` — drift suspects. */
export function driftSuspectPhases(card: Pick<SpecCard, "phases">): SpecPhase[] {
  return card.phases.filter((p) => p.status === "shipped" && (p.pr ?? null) === null);
}

/** Any shipped phase missing its merge-hook provenance? — the "this card looks shipped but isn't proved" gate. */
export function hasDriftSuspectPhase(card: Pick<SpecCard, "phases">): boolean {
  return driftSuspectPhases(card).length > 0;
}

/**
 * True iff the spec is fully shipped AND every shipped phase carries merge-hook provenance. Use this in
 * place of `card.status === "shipped"` wherever the answer means "definitely done, skip past it" — the
 * merge hook is the only writer of `pr`, so a missing tag means we cannot prove the phase landed.
 *
 * For a **one-shot spec** (no `## Phase` sections), provenance lives at the card level (`flags.merged_pr`,
 * surfaced as `card.shippedPr`); for a multi-phase spec it lives on every non-rejected phase.
 */
export function isCardFullyShippedWithProvenance(
  card: Pick<SpecCard, "status" | "phases" | "shippedPr">,
): boolean {
  if (card.status !== "shipped") return false;
  const relevant = card.phases.filter((p) => p.status !== "rejected");
  if (!relevant.length) return (card.shippedPr ?? null) !== null;
  return relevant.every((p) => phaseHasProvenance(p));
}

/** How many of the card's phases ACTUALLY landed (status='shipped' AND pr set). Use this in place of
 *  `counts.shipped` whenever the answer drives an autonomous "this phase is done" decision. */
export function provenanceShippedCount(card: Pick<SpecCard, "phases">): number {
  return card.phases.filter(phaseHasProvenance).length;
}
