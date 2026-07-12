/**
 * Unit tests for the goal-member discriminator — mario-never-reclaims-a-goal-member-already-
 * integrated-on-its-goal-branch Phase 1. Pins the verification bullets from the spec:
 *
 *   (a) goal member, branch contained in goal branch, goal.main_merge_sha null → awaiting
 *       (no reclaim).
 *   (b) goal member NOT yet on its goal branch → still reclaimable.
 *   (c) goal already promoted (main_merge_sha set) → normal handling.
 *   (d) standalone spec (no milestone_id) → unaffected, reclaims as today.
 *
 * Pure predicate — no I/O, no DB. Run:
 *   npx tsx --test src/lib/mario.goal-member.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isGoalMemberAwaitingPromotion } from "./mario";

test(
  "(a) goal member integrated on its goal branch, goal.main_merge_sha null → AWAITING (no reclaim)",
  () => {
    const awaiting = isGoalMemberAwaitingPromotion({
      milestoneId: "m-uuid-1",
      goalBranchSha: "abc123",   // its claude/build-<slug> merged onto goal/<goalSlug>
      goalMainMergeSha: null,    // the goal has NOT yet atomically promoted to main
    });
    assert.equal(awaiting, true);
  },
);

test(
  "(b) goal member NOT yet on its goal branch → NOT awaiting (still reclaimable — genuine 'not integrated')",
  () => {
    const awaiting = isGoalMemberAwaitingPromotion({
      milestoneId: "m-uuid-1",
      goalBranchSha: null,       // its build has not merged onto the goal branch yet
      goalMainMergeSha: null,
    });
    assert.equal(awaiting, false);
  },
);

test(
  "(c) goal already promoted (main_merge_sha set) → NOT awaiting (normal handling)",
  () => {
    const awaiting = isGoalMemberAwaitingPromotion({
      milestoneId: "m-uuid-1",
      goalBranchSha: "abc123",
      goalMainMergeSha: "def456", // the goal HAS promoted to main
    });
    assert.equal(awaiting, false);
  },
);

test(
  "(d) standalone spec (no milestone_id) → NOT awaiting (unaffected, reclaims as today)",
  () => {
    const awaiting = isGoalMemberAwaitingPromotion({
      milestoneId: null,          // it's a standalone spec, not a goal member
      goalBranchSha: null,
      goalMainMergeSha: null,
    });
    assert.equal(awaiting, false);
  },
);

test(
  "standalone spec with a stray goal_branch_sha (defensive: none should exist, but if it did — milestone_id null still short-circuits to NOT awaiting)",
  () => {
    // This shape should never appear in practice — a spec's goal_branch_sha is only stamped by
    // stampSpecGoalBranchSha, which is called from the goal-branch integration flow which requires
    // a milestone. Belt-and-suspenders: the milestone_id gate wins.
    const awaiting = isGoalMemberAwaitingPromotion({
      milestoneId: null,
      goalBranchSha: "stray",
      goalMainMergeSha: null,
    });
    assert.equal(awaiting, false);
  },
);
