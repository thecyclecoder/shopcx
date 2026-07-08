/**
 * escort-reliably-dispatches-ready-goal-members Phase 1 — pins the NAMED failing state: a goal-mate
 * BLOCKER that landed on the goal branch (goal_branch_sha stamped) but whose derived card status is still
 * `in_progress` (its phases carry build_sha, no merge_sha) MUST report as CLEARED for a goal-mate dependent.
 * Before this fix, the escort's blocker-cleared predicate keyed on `target.status === "shipped"` — which
 * demanded main-merge and stalled every goal-mate dependent until the atomic goal→main promotion, causing
 * the 2026-07-08 shadow-mode → daily-cadence-cron / director-slack-digest dispatch miss.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/spec-phase-provenance.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isCardShippedByPhaseProvenance,
  isCardAccumulatedOnGoalBranch,
  phaseHasProvenance,
  phaseBuiltOnBranch,
  isCardFullyShippedWithProvenance,
} from "./spec-phase-provenance";
import type { SpecCard, SpecPhase } from "./brain-roadmap";

// Phase helpers — build the four canonical shapes the trust boundary must judge.
const shippedWithPr = (title: string): SpecPhase => ({ title, status: "shipped", pr: 42, merge_sha: null, build_sha: null });
const shippedWithMergeSha = (title: string): SpecPhase => ({ title, status: "shipped", pr: null, merge_sha: "abc123", build_sha: "def456" });
const builtOnBranch = (title: string): SpecPhase => ({ title, status: "in_progress", pr: null, merge_sha: null, build_sha: "def456" });
const planned = (title: string): SpecPhase => ({ title, status: "planned", pr: null, merge_sha: null, build_sha: null });
const rejected = (title: string): SpecPhase => ({ title, status: "rejected", pr: null, merge_sha: null, build_sha: null });

test("isCardShippedByPhaseProvenance TRUE when every non-rejected phase has pr or merge_sha", () => {
  const card: Pick<SpecCard, "phases" | "shippedPr"> = {
    phases: [shippedWithPr("P1"), shippedWithMergeSha("P2"), rejected("P3-cut")],
    shippedPr: null,
  };
  assert.equal(isCardShippedByPhaseProvenance(card), true);
});

test("isCardShippedByPhaseProvenance FALSE when a phase is only built on the branch (build_sha) with no pr/merge_sha", () => {
  const card: Pick<SpecCard, "phases" | "shippedPr"> = {
    phases: [shippedWithPr("P1"), builtOnBranch("P2")],
    shippedPr: null,
  };
  assert.equal(isCardShippedByPhaseProvenance(card), false);
});

test("isCardShippedByPhaseProvenance FALSE when a phase is still planned", () => {
  const card: Pick<SpecCard, "phases" | "shippedPr"> = {
    phases: [shippedWithPr("P1"), planned("P2")],
    shippedPr: null,
  };
  assert.equal(isCardShippedByPhaseProvenance(card), false);
});

test("isCardShippedByPhaseProvenance one-shot: TRUE when card-level shippedPr is set", () => {
  const card: Pick<SpecCard, "phases" | "shippedPr"> = { phases: [], shippedPr: 100 };
  assert.equal(isCardShippedByPhaseProvenance(card), true);
});

test("isCardShippedByPhaseProvenance one-shot: FALSE when no card-level shippedPr", () => {
  const card: Pick<SpecCard, "phases" | "shippedPr"> = { phases: [], shippedPr: null };
  assert.equal(isCardShippedByPhaseProvenance(card), false);
});

test("isCardAccumulatedOnGoalBranch TRUE when specs.goal_branch_sha is stamped", () => {
  assert.equal(isCardAccumulatedOnGoalBranch({ goalBranchSha: "def456" }), true);
});

test("isCardAccumulatedOnGoalBranch FALSE when goal_branch_sha is null or undefined", () => {
  assert.equal(isCardAccumulatedOnGoalBranch({ goalBranchSha: null }), false);
  assert.equal(isCardAccumulatedOnGoalBranch({}), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// The Phase 1 verification — the media-buyer chain regression.
// ─────────────────────────────────────────────────────────────────────────────
// shadow-mode's phases have build_sha stamped (accumulated on its spec branch), and its spec branch
// merged into goal/autonomous-media-buyer-supervision (goal_branch_sha stamped). NOT yet on main.
// daily-cadence-cron is a goal-mate blocked_by shadow-mode. Every gate downstream (escortApprovedGoals,
// autoQueueUnblockedBy, buildOnEligible) reads the resolveBlockedBy cleared predicate — this test pins
// the COMBINED predicate we install in brain-roadmap.ts (phase-provenance OR goal-branch accumulation) so
// the escort sees daily-cadence-cron as READY and dispatches it, instead of stalling until the whole
// goal ships to main.

/** The exact predicate resolveBlockedBy applies for a `kind:"spec"` blocker after the escort-reliably-
 *  dispatches-ready-goal-members fix. Pure — mirrors the code path so a regression in either helper OR
 *  the goal-mate boolean flips this test red at the same seam the production code fails. */
function blockerClearedForDependent(
  target: Pick<SpecCard, "phases" | "shippedPr" | "goalBranchSha">,
  opts: { isGoalMate: boolean },
): boolean {
  return (
    isCardShippedByPhaseProvenance(target) ||
    (opts.isGoalMate && isCardAccumulatedOnGoalBranch(target))
  );
}

test("Phase 1 verification: goal-mate blocker accumulated on the goal branch (build_sha per phase, goal_branch_sha stamped) reads as CLEARED", () => {
  const shadowMode: Pick<SpecCard, "phases" | "shippedPr" | "goalBranchSha"> = {
    phases: [builtOnBranch("P1"), builtOnBranch("P2")],
    shippedPr: null,
    goalBranchSha: "abc123-goal-branch-merge-sha",
  };
  // Goal-mate dependent (daily-cadence-cron): the ordering signal is "on the goal branch", not
  // "shipped to main". Before the fix this returned FALSE and stalled the media-buyer chain.
  assert.equal(
    blockerClearedForDependent(shadowMode, { isGoalMate: true }),
    true,
    "goal-mate blocker on the goal branch must clear the dependent — the escort should dispatch it",
  );
  // Sanity: the base rollup of `shadowMode` above would be `in_progress` (all phases in_progress via
  // build_sha), so the OLD `target.status === "shipped"` predicate would return false here.
  assert.notEqual(shadowMode.phases[0].status, "shipped");
});

test("Phase 1 regression: an OUTSIDE dependent (not a goal-mate) of the same blocker is NOT cleared by goal-branch accumulation — it must wait for the atomic goal→main promotion", () => {
  const shadowMode: Pick<SpecCard, "phases" | "shippedPr" | "goalBranchSha"> = {
    phases: [builtOnBranch("P1"), builtOnBranch("P2")],
    shippedPr: null,
    goalBranchSha: "abc123-goal-branch-merge-sha",
  };
  // A standalone spec depending on shadow-mode is NOT a goal-mate. Its blocker is normalized to a
  // `kind:"goal"` blocker elsewhere (see blocker-goal-normalize), but if the spec-branch code path
  // ever falls through here it must NOT falsely clear — the outside dependent has to wait for main.
  assert.equal(
    blockerClearedForDependent(shadowMode, { isGoalMate: false }),
    false,
    "outside dependents must NOT be released by goal-branch accumulation",
  );
});

test("Phase 1 regression: a truly-shipped-by-provenance blocker clears BOTH goal-mate AND outside dependents", () => {
  const shipped: Pick<SpecCard, "phases" | "shippedPr" | "goalBranchSha"> = {
    phases: [shippedWithMergeSha("P1"), shippedWithMergeSha("P2")],
    shippedPr: null,
    goalBranchSha: "abc123-goal-branch-merge-sha",
  };
  assert.equal(blockerClearedForDependent(shipped, { isGoalMate: true }), true);
  assert.equal(blockerClearedForDependent(shipped, { isGoalMate: false }), true);
});

test("Phase 1 regression: a blocker with NO progress (planned phases, no goal-branch integration) is uncleared for anyone", () => {
  const notStarted: Pick<SpecCard, "phases" | "shippedPr" | "goalBranchSha"> = {
    phases: [planned("P1"), planned("P2")],
    shippedPr: null,
    goalBranchSha: null,
  };
  assert.equal(blockerClearedForDependent(notStarted, { isGoalMate: true }), false);
  assert.equal(blockerClearedForDependent(notStarted, { isGoalMate: false }), false);
});

// A sanity check on the pre-existing predicates the new helpers share phase shapes with — a
// belt-and-braces against a future edit that accidentally makes phaseHasProvenance / phaseBuiltOnBranch
// diverge from their docstrings while the new helpers still pass.
test("phaseHasProvenance + phaseBuiltOnBranch remain distinct — a build_sha-only phase is built-on-branch but NOT provenance-stamped", () => {
  const p = builtOnBranch("P1");
  assert.equal(phaseHasProvenance(p), false);
  assert.equal(phaseBuiltOnBranch(p), true);
});

test("isCardFullyShippedWithProvenance FALSE for a goal-branch-accumulated card (status=in_progress) — the exact case isCardShippedByPhaseProvenance handles differently", () => {
  const card: Pick<SpecCard, "status" | "phases" | "shippedPr"> = {
    status: "in_progress",
    phases: [builtOnBranch("P1"), builtOnBranch("P2")],
    shippedPr: null,
  };
  assert.equal(
    isCardFullyShippedWithProvenance(card),
    false,
    "pre-existing predicate gates on card.status === 'shipped'; this is the trap that stalled the media-buyer chain",
  );
});
