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

/**
 * True iff this phase's `shipped` status is backed by a merge-hook stamp. The stamp is EITHER a `pr` # (the
 * per-spec PR-merge path, [[applyMergedBuildEffects]]) OR a `merge_sha` (the ATOMIC goal→main promotion,
 * [[applyGoalPromotionEffects]] — spec-goal-branch-pm-flow M5). A goal-bound spec NEVER takes a per-spec PR:
 * its whole goal branch lands on main in ONE `/merges` call with no PR, so the only provenance it can carry
 * is the M5 `merge_sha` (the actual main commit — a STRONGER landing proof than a PR #). Keying solely on
 * `pr` falsely flagged every goal-promoted phase as drift-suspect (post-M5-goal-finalization). Either stamp
 * proves the phase landed on main.
 */
export function phaseHasProvenance(p: Pick<SpecPhase, "status" | "pr" | "merge_sha">): boolean {
  return p.status === "shipped" && ((p.pr ?? null) !== null || (p.merge_sha ?? null) !== null);
}

/** Phases the card carries that are tagged `shipped` but lack BOTH a `pr` and a `merge_sha` — drift suspects
 *  (a status flip with no merge-hook stamp of either kind). */
export function driftSuspectPhases(card: Pick<SpecCard, "phases">): SpecPhase[] {
  return card.phases.filter((p) => p.status === "shipped" && (p.pr ?? null) === null && (p.merge_sha ?? null) === null);
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

/** How many of the card's phases ACTUALLY landed (status='shipped' AND a merge-hook stamp — `pr` OR
 *  `merge_sha`). Use this in place of `counts.shipped` whenever the answer drives an autonomous "this phase
 *  is done" decision. */
export function provenanceShippedCount(card: Pick<SpecCard, "phases">): number {
  return card.phases.filter(phaseHasProvenance).length;
}

/**
 * spec-goal-branch-pm-flow M2 — true iff this phase has BUILT on the spec branch: it carries a `build_sha`
 * (stampPhaseBuilt recorded the `claude/build-{slug}` commit) OR it already shipped to main (which subsumes
 * "built"). Under M1's branch-accumulation model a phase reaches "built" LONG before it gets the main-merge
 * `pr` tag (M5 stamps `pr`/shipped only on promotion), so the "is this phase done building?" question can no
 * longer be answered by `phaseHasProvenance` (which keys off `pr`) alone — it would read 0 for an entire
 * branch-flow spec and stall the next-phase advance. This is the branch-flow counterpart.
 */
export function phaseBuiltOnBranch(p: Pick<SpecPhase, "status" | "build_sha">): boolean {
  if (p.status === "shipped") return true; // shipped subsumes built (a shipped phase was built first)
  return (p.build_sha ?? null) !== null;
}

/**
 * spec-goal-branch-pm-flow M2 — how many phases have BUILT (on the branch or shipped to main). The
 * branch-flow counterpart to {@link provenanceShippedCount}: use it where the answer means "≥1 phase is done
 * building so the spec is STARTED/partially-built" (e.g. the grooming next-phase candidate filter), which
 * must now trigger off branch-build, not the main-merge `pr` tag.
 */
export function branchBuiltCount(card: Pick<SpecCard, "phases">): number {
  return card.phases.filter(phaseBuiltOnBranch).length;
}

/**
 * escort-reliably-dispatches-ready-goal-members Phase 1 — TRUE iff the target spec has been TRULY SHIPPED via
 * phase-provenance stamps (every non-rejected phase carries `pr` OR `merge_sha`, or the one-shot card-level
 * `shippedPr` is set). Independent of derived card status — an `in_testing` overlay or a base rollup that
 * hasn't caught up cannot mask a truly-shipped card here.
 *
 * Use in place of `target.status === "shipped"` for the "is this blocker actually landed?" predicate — the
 * check callers (`resolveBlockedBy`, escort readiness scans) need to trust the merge-hook stamp, not a
 * derived rollup that may not reflect it yet.
 */
export function isCardShippedByPhaseProvenance(
  card: Pick<SpecCard, "phases" | "shippedPr">,
): boolean {
  const relevant = card.phases.filter((p) => p.status !== "rejected");
  if (!relevant.length) return (card.shippedPr ?? null) !== null;
  return relevant.every((p) => phaseHasProvenance(p));
}

/**
 * escort-reliably-dispatches-ready-goal-members Phase 1 — TRUE iff the target spec has landed on its GOAL
 * BRANCH (`specs.goal_branch_sha` stamped). This is the intra-goal serializer's clearance for a GOAL-MATE
 * dependent: the goal branch now carries this spec's diff, so a downstream goal-mate can build off it.
 * The derived card status stays `in_progress` until the whole goal ships to main, so a goal-mate cleared
 * check must NOT key on `target.status === "shipped"` — that stall is the exact ready-member dispatch gap
 * this predicate closes.
 *
 * ONLY use for GOAL-MATE blocker relationships (dependent + blocker in the same goal). An outside dependent
 * must wait for the atomic goal→main promotion — use [[isCardShippedByPhaseProvenance]] OR the
 * `kind:"goal"` `goals.main_merge_sha` predicate the outside-dependent normalizer already installs.
 */
export function isCardAccumulatedOnGoalBranch(
  card: Pick<SpecCard, "goalBranchSha">,
): boolean {
  return (card.goalBranchSha ?? null) !== null;
}
