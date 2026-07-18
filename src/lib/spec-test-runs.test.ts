/**
 * Unit tests for the goal-bound-defer rail of the fold gate
 * (goal-promotion-fold-collision-and-held-surfacing Phase 1). Pins the four states of
 * `isFoldSafeGivenGoalStatus` from the spec's failing-state:
 *
 *   1. a one-off spec (null goal) folds normally (safe).
 *   2. a spec whose parent goal is `proposed` DEFERS (unsafe — atomic promotion has not landed).
 *   3. a spec whose parent goal is `greenlit` DEFERS (unsafe — atomic promotion in-flight,
 *      the failing state of the 2026-07-06 centralized-commerce-sdk incident: `greenlit` is
 *      what `goals.status` reads BEFORE `finalizePromotedGoal` flips it → `complete`).
 *   4. a spec whose parent goal has landed (`complete`) folds normally (safe — atomic merge
 *      already brought the goal branch's brain-page edits to `main`).
 *   5. a spec whose parent goal is `folded` folds normally (safe — same reason).
 *
 * Pure helper — no I/O, no DB. Run:
 *   npx tsx --test src/lib/spec-test-runs.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isCleanMachinePassRun,
  isFoldAllowedZeroCheckRun,
  isFoldSafeGivenGoalStatus,
  type SpecTestRun,
} from "./spec-test-runs";

test("isFoldSafeGivenGoalStatus: null goal (one-off spec) → safe to fold", () => {
  assert.equal(isFoldSafeGivenGoalStatus(null), true);
});

test("isFoldSafeGivenGoalStatus: `proposed` goal → DEFER (goal not yet atomically promoted)", () => {
  assert.equal(isFoldSafeGivenGoalStatus("proposed"), false);
});

test("isFoldSafeGivenGoalStatus: `greenlit` goal → DEFER (the failing state — atomic promotion HELD/pending)", () => {
  // The 2026-07-06 centralized-commerce-sdk incident: `goals.status='greenlit'` while the goal branch
  // was accumulating brain-page edits, and each spec's fold hit main ahead of the atomic merge → 409.
  // The correct-state assertion of the whole Phase 1 fix.
  assert.equal(isFoldSafeGivenGoalStatus("greenlit"), false);
});

test("isFoldSafeGivenGoalStatus: `complete` goal → safe to fold (atomic promotion landed)", () => {
  // `finalizePromotedGoal` flips `greenlit → complete` right after `mergeGoalBranchIntoMain` succeeds,
  // so a `complete` stored status is the earliest post-atomic-merge signal the goal reader sees.
  assert.equal(isFoldSafeGivenGoalStatus("complete"), true);
});

test("isFoldSafeGivenGoalStatus: `folded` goal → safe to fold (goal-fold already retired the row)", () => {
  assert.equal(isFoldSafeGivenGoalStatus("folded"), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// fold-never-strands-a-shipped-spec-with-a-zero-machine-check-spec-test Phase 2
//
// The FOLD-ONLY zero-check allowance. Pins the exact named failing state: a run whose Verification
// defines zero `kind='auto'` checks lands a clean 0-check spec-test run, `isCleanMachinePassRun`
// rejects it via the `checks.length >= 1` floor, and the primary auto-fold sweep strands it forever.
// The Phase 2 fix accepts THIS case at the fold-eligibility rail — but keeps `isCleanMachinePassRun`
// (the SHARED pre-merge promote gate) unchanged, so the two rails DIVERGE on purpose.
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<SpecTestRun>): SpecTestRun {
  return {
    id: "run-1",
    workspace_id: "ws-1",
    spec_slug: "dahlia-researches-from-winners-flow-ad-library",
    agent_job_id: null,
    agent_verdict: "approved",
    summary: { auto_pass: 0, auto_fail: 0, needs_human: 0, inconclusive: 0 },
    checks: [],
    transcript: null,
    error: null,
    spec_branch: null,
    preview_url: null,
    run_at: "2026-07-01T00:00:00Z",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

test("isFoldAllowedZeroCheckRun: clean verdict + 0 asserted checks + spec defined 0 auto checks → ALLOWED (the recovered stranded state)", () => {
  // The exact named failing state: dahlia-researches-from-winners-flow-ad-library had a clean
  // verdict AND recorded 0 machine checks because its Verification defined no auto-runnable ones.
  // Phase 2 allows THIS class through the fold gate on the first pass.
  assert.equal(isFoldAllowedZeroCheckRun(makeRun({ agent_verdict: "approved" }), 0), true);
  assert.equal(isFoldAllowedZeroCheckRun(makeRun({ agent_verdict: "needs_human" }), 0), true);
});

test("isFoldAllowedZeroCheckRun: spec DEFINED auto checks but run asserted 0 → REJECTED (the degenerate silent-empty-pass case)", () => {
  // If the Verification declares real machine checks but the run asserted none, that IS the
  // degenerate "silent empty pass" the checks-floor originally guarded against — the agent errored
  // before running the declared checks. The fold allowance MUST NOT let it through.
  assert.equal(isFoldAllowedZeroCheckRun(makeRun({ agent_verdict: "approved" }), 3), false);
  assert.equal(isFoldAllowedZeroCheckRun(makeRun({ agent_verdict: "needs_human" }), 1), false);
});

test("isFoldAllowedZeroCheckRun: non-clean verdict → REJECTED even with 0 defined checks", () => {
  // `issues` / `error` still reject — this branch is for the CLEAN 0-check case only. A non-clean
  // 0-check run is a real failure (or an unparseable run) and must not fold on the allowance.
  assert.equal(isFoldAllowedZeroCheckRun(makeRun({ agent_verdict: "issues" }), 0), false);
  assert.equal(isFoldAllowedZeroCheckRun(makeRun({ agent_verdict: "error" }), 0), false);
});

test("isFoldAllowedZeroCheckRun: a run that ASSERTED ≥1 check → REJECTED (handled by isCleanMachinePassRun path)", () => {
  // A run with ≥1 check goes through the shared `isCleanMachinePassRun` path — the allowance
  // branch is strictly for the 0-check case. Both paths lead to eligibility in the caller when
  // their respective conditions hold; this branch does NOT reach across.
  const withOneCheck = makeRun({
    checks: [{ text: "x", verdict: "pass", category: "auto" }] as unknown as SpecTestRun["checks"],
  });
  assert.equal(isFoldAllowedZeroCheckRun(withOneCheck, 0), false);
});

test("isCleanMachinePassRun: a 0-check clean run STILL FAILS the shared predicate (the promote-gate divergence)", () => {
  // The promote-gate divergence — `isCleanMachinePassRun` (used by the pre-merge promote gate) keeps
  // its `checks.length >= 1` floor. If this ever passes true here, the fold allowance would have
  // silently loosened the shared predicate and every pre-merge silent-empty-pass would promote.
  const zeroCheckClean = makeRun({ agent_verdict: "approved", checks: [] });
  assert.equal(isCleanMachinePassRun(zeroCheckClean, new Map(), "any-slug"), false);
});
