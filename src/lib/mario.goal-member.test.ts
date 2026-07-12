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

// ── Phase 2 — pre-screen drop invariants ─────────────────────────────────────────────────────
//
// The M3 legit-wait pre-screen in `evaluateStalledSpecs` folds `isGoalMemberAwaitingPromotion`
// into the drop set alongside folded/deferred/uncleared-blocker/wait-status (see step (d2) in
// src/lib/mario.ts). These tests pin the drop's semantics under the Phase-2 frame — the pure
// predicate is the exact seam the pre-screen consumes, so a pinned predicate is a pinned drop.
// Same class of test as mario.blocked-by.test.ts pinning `shouldSurfaceMissingBlocker` for the
// fifth-source drop chain.

test(
  "Phase 2 — a goal at 6/6-integrated-awaiting-promotion: EVERY member reads as awaiting → the pre-screen drops all six → zero mario_fired rows",
  () => {
    // Six members, all with a stamped goal_branch_sha, same milestone → same goal (main_merge_sha null).
    // The predicate is per-spec, so the invariant "all six drop" is per-spec (all six read true).
    const members = Array.from({ length: 6 }, (_, i) => ({
      milestoneId: "m-uuid-1",
      goalBranchSha: `sha-${i}`,
      goalMainMergeSha: null,
    }));
    for (const m of members) assert.equal(isGoalMemberAwaitingPromotion(m), true);
  },
);

test(
  "Phase 2 — a genuinely stalled goal member (not yet integrated, past its wait budget) STILL surfaces (predicate returns false → pre-screen does NOT drop → mario fires)",
  () => {
    // Timing is orthogonal to this drop: a candidate REACHES the pre-screen only because it's
    // already past its SLA (that's the a-step that surfaced it). So "past its wait budget" is a
    // precondition of every case here. The drop predicate only cares about integration state; a
    // not-yet-integrated goal member is a genuine stall and must survive the drop.
    const stillStalled = isGoalMemberAwaitingPromotion({
      milestoneId: "m-uuid-1",
      goalBranchSha: null,       // build has NOT merged onto the goal branch — genuine stall
      goalMainMergeSha: null,
    });
    assert.equal(stillStalled, false);
  },
);
