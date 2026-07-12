/**
 * builder-self-heals-stale-build-branch Phase 1 — reconciliation strategy tests.
 *
 * Pins the NAMED failing state from 2026-07-11: a goal-member build branch (director-chat-in-
 * leash-execution, machine-declared-verification-and-deterministic-spec-test-runner) inherits
 * merge commits from the goal branch's reconciliation with main, and `git rebase origin/main`
 * spuriously conflicts on every retry while `git merge origin/main` applies CLEAN — the loop
 * guard escalated the same self-healable staleness twice to the CEO inbox.  The primary
 * predicate MUST pick MERGE for a non-linear branch, and the fallback MUST recreate-fresh only
 * when no built work is at risk.
 *
 * Pure — no I/O.  Run:
 *   npx tsx --test src/lib/build-lane-reconcile.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseReconcile,
  chooseReconcileFallback,
  type ReconcileInput,
} from "./build-lane-reconcile";

const base: ReconcileInput = {
  headContainsMain: false,
  hasMergeCommits: false,
  hasBuiltWork: false,
  branchOnRemote: false,
};

test("HEAD already contains main → skip (nothing to reconcile)", () => {
  assert.equal(chooseReconcile({ ...base, headContainsMain: true }), "skip");
});

test("non-linear branch (merge commits since divergence) → merge (primary — rebase would spuriously conflict)", () => {
  // The 2026-07-11 director-chat / ceo-org-control-tower shape: goal-member branch inherits
  // merge commits from the goal branch's main reconciliation.  A `git rebase origin/main`
  // replays the merges and hits the SAME conflict every retry (that is what escalated to the
  // CEO twice).  A `git merge origin/main` applies CLEAN.  Primary MUST be MERGE.
  assert.equal(chooseReconcile({ ...base, hasMergeCommits: true }), "merge");
});

test("truly-linear branch (no merge commits) → rebase (primary — clean linear replay)", () => {
  // A one-off spec's first phase, cut off main with a single linear commit ahead.  Rebase is
  // safe and produces the cleanest history.
  assert.equal(chooseReconcile({ ...base, hasMergeCommits: false }), "rebase");
});

test("goal-member branch with built work AND merge commits → merge (never rewrite BUILT commits)", () => {
  // A member branch with a merge from goal + a built phase on top.  Primary MERGE keeps every
  // built commit's SHA intact so downstream stampPhaseBuilt's `build_sha` stays valid.
  assert.equal(
    chooseReconcile({
      ...base,
      hasMergeCommits: true,
      hasBuiltWork: true,
      branchOnRemote: true,
    }),
    "merge",
  );
});

test("fallback: primary merge conflicted, branch has built work → rebase (never recreate)", () => {
  // Invariant: hasBuiltWork gates recreate-fresh OFF.  A built phase's commit is durable state
  // the fallback must never drop, so flip to the OTHER reconcile approach (rebase).
  assert.equal(
    chooseReconcileFallback({
      ...base,
      hasMergeCommits: true,
      hasBuiltWork: true,
      branchOnRemote: true,
    }),
    "rebase",
  );
});

test("fallback: primary rebase conflicted, box-local branch with NO built work → recreate-fresh", () => {
  // The director-chat-in-leash-execution case named in the spec: box-local branch, zero built
  // work, human could not reset it remotely.  Its commits are throwaway attempts from an
  // earlier failed session — safe to reset onto the correct base.
  assert.equal(
    chooseReconcileFallback({
      ...base,
      hasMergeCommits: false,
      hasBuiltWork: false,
      branchOnRemote: false,
    }),
    "recreate-fresh",
  );
});

test("fallback: primary rebase conflicted, NO built work but PUSHED to origin → merge (preserve remote history)", () => {
  // On-origin branch: recreating fresh would rewrite the remote → forbidden.  Fall back to
  // merge instead (which never rewrites the branch).
  assert.equal(
    chooseReconcileFallback({
      ...base,
      hasMergeCommits: false,
      hasBuiltWork: false,
      branchOnRemote: true,
    }),
    "merge",
  );
});

test("fallback: primary merge conflicted, built work exists → NEVER recreate-fresh (invariant)", () => {
  // Belt-and-suspenders: with any built work at all, the fallback must NOT be recreate-fresh.
  // No configuration of the other flags can override this.
  for (const branchOnRemote of [true, false]) {
    for (const hasMergeCommits of [true, false]) {
      const r = chooseReconcileFallback({
        ...base,
        hasBuiltWork: true,
        hasMergeCommits,
        branchOnRemote,
      });
      assert.notEqual(r, "recreate-fresh", `hasBuiltWork=true must forbid recreate-fresh (branchOnRemote=${branchOnRemote}, hasMergeCommits=${hasMergeCommits})`);
    }
  }
});

test("fallback: headContainsMain → skip (defensive; caller should not invoke fallback in this state)", () => {
  // A wrong fallback call when nothing needed reconciling is a no-op, not a wrong action.
  assert.equal(
    chooseReconcileFallback({ ...base, headContainsMain: true }),
    "skip",
  );
});
