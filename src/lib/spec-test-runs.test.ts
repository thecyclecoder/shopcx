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
import { isFoldSafeGivenGoalStatus } from "./spec-test-runs";

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
