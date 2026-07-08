/**
 * Unit tests for the fail-closed PR-selection helper the GitHub-PR-merged reconciler uses
 * (stamp-phases-on-github-pr-merged Phase 2). Pins the four verification bullets from the spec:
 *
 *   1. an OPEN PR is NEVER stamped;
 *   2. a CLOSED-without-merge PR is NEVER stamped;
 *   3. a branch with BOTH a MERGED and a CLOSED-unmerged PR resolves to the MERGED PR — regardless
 *      of API iteration order (the #961-merged / #949-closed shape from fix-spec-brain-refs);
 *   4. on a simulated GitHub read failure (null/undefined/non-array) the picker returns null and
 *      does NOT throw, so the outer reconciler skips the spec and a later pass retries.
 *
 * Pure helper — no I/O, no DB. Run:
 *   npm run test:spec-drift
 *   (= tsx --test src/lib/spec-drift.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isGoalPendingPromotion, pickMergedPrFromList, type BranchPrCandidate } from "./spec-drift";
import type { GoalRow } from "./goals-table";

const OPEN: BranchPrCandidate = { number: 100, merged_at: null, merge_commit_sha: null };
const CLOSED_UNMERGED: BranchPrCandidate = { number: 949, merged_at: null, merge_commit_sha: null };
const MERGED: BranchPrCandidate = {
  number: 961,
  merged_at: "2026-07-02T00:00:00Z",
  merge_commit_sha: "deadbeef",
};

test("pickMergedPrFromList: an empty list yields null (no PRs → no stamp)", () => {
  assert.equal(pickMergedPrFromList([]), null);
});

test("pickMergedPrFromList: an OPEN PR is NEVER stamped (bullet 1)", () => {
  assert.equal(pickMergedPrFromList([OPEN]), null);
});

test("pickMergedPrFromList: a CLOSED-unmerged PR is NEVER stamped (bullet 2 — the #949-closed shape)", () => {
  assert.equal(pickMergedPrFromList([CLOSED_UNMERGED]), null);
});

test("pickMergedPrFromList: a MERGED PR stamps with its number + merge_commit_sha (positive path)", () => {
  assert.deepEqual(pickMergedPrFromList([MERGED]), { number: 961, merge_sha: "deadbeef" });
});

test("pickMergedPrFromList: MERGED wins over CLOSED-unmerged when CLOSED comes FIRST (bullet 3 — iteration order shouldn't matter)", () => {
  // The #961-merged / #949-closed shape from fix-spec-brain-refs: API might return CLOSED first.
  assert.deepEqual(pickMergedPrFromList([CLOSED_UNMERGED, MERGED]), {
    number: 961,
    merge_sha: "deadbeef",
  });
});

test("pickMergedPrFromList: MERGED wins over CLOSED-unmerged when MERGED comes FIRST (bullet 3 — the symmetric order)", () => {
  assert.deepEqual(pickMergedPrFromList([MERGED, CLOSED_UNMERGED]), {
    number: 961,
    merge_sha: "deadbeef",
  });
});

test("pickMergedPrFromList: MERGED wins over an OPEN PR too (bullet 3 — should generalize past the CLOSED case)", () => {
  assert.deepEqual(pickMergedPrFromList([OPEN, MERGED]), { number: 961, merge_sha: "deadbeef" });
});

test("pickMergedPrFromList: a MERGED PR without a merge_commit_sha still stamps (with merge_sha=null) — a stamp with a real PR # is provenance enough for the audit trail", () => {
  const mergedNoSha: BranchPrCandidate = {
    number: 962,
    merged_at: "2026-07-02T00:00:00Z",
    merge_commit_sha: null,
  };
  assert.deepEqual(pickMergedPrFromList([mergedNoSha]), { number: 962, merge_sha: null });
});

test("pickMergedPrFromList: null input yields null and does NOT throw (bullet 4 — simulated GitHub read failure)", () => {
  assert.doesNotThrow(() => pickMergedPrFromList(null));
  assert.equal(pickMergedPrFromList(null), null);
});

test("pickMergedPrFromList: undefined input yields null and does NOT throw (bullet 4 — the missing-token / no-payload shape)", () => {
  assert.doesNotThrow(() => pickMergedPrFromList(undefined));
  assert.equal(pickMergedPrFromList(undefined), null);
});

test("pickMergedPrFromList: a non-array payload (e.g. GitHub returned an error object) yields null (bullet 4 — the outer guard `Array.isArray(res.json)` fails, but the picker is defensive too)", () => {
  const garbage = { message: "Bad credentials" } as unknown as BranchPrCandidate[];
  assert.doesNotThrow(() => pickMergedPrFromList(garbage));
  assert.equal(pickMergedPrFromList(garbage), null);
});

// ── isGoalPendingPromotion — reese-goal-aware-drift Phase 1 ────────────────────────────────────
//
// The named failing state: a shipped phase of a goal member whose goal.main_merge_sha is null was
// being classified as reverse-drift by the on-main path check (three currently-open Sol rows).
// These tests pin the guard: the goal-pending case returns `pending: true`; every non-pending shape
// (standalone spec / goal member post-merge / unknown milestone) returns `pending: false` so a
// genuine post-merge revert still opens a drift row.

const NOW = "2026-07-08T00:00:00Z";
function goal(input: { slug: string; milestones: Array<{ id: string; position?: number; title?: string }>; main_merge_sha: string | null }): GoalRow {
  return {
    id: `g-${input.slug}`,
    workspace_id: "ws",
    slug: input.slug,
    title: input.slug,
    body: "",
    outcome: null,
    success_metric: null,
    owner: "platform",
    proposer_function: null,
    parent_goal_id: null,
    is_parent: false,
    status: "greenlit",
    why: null,
    main_merge_sha: input.main_merge_sha,
    promotion_held_reason: null,
    created_at: NOW,
    updated_at: NOW,
    milestones: input.milestones.map((m, i) => ({
      id: m.id,
      goal_id: `g-${input.slug}`,
      position: m.position ?? i + 1,
      title: m.title ?? `M${i + 1}`,
      body: null,
      why: null,
      what: null,
      created_at: NOW,
      updated_at: NOW,
    })),
  };
}

test("isGoalPendingPromotion: goal member whose goal main_merge_sha is null → pending:true (the Sol false-positive shape)", () => {
  const goals = [goal({ slug: "sol", milestones: [{ id: "m-sol-1" }], main_merge_sha: null })];
  const v = isGoalPendingPromotion("m-sol-1", goals);
  assert.equal(v.pending, true);
  assert.equal(v.goalSlug, "sol");
});

test("isGoalPendingPromotion: goal member AFTER its goal promoted (main_merge_sha set) → pending:false (drift row still opens for real revert)", () => {
  const goals = [goal({ slug: "sol", milestones: [{ id: "m-sol-1" }], main_merge_sha: "abc123" })];
  const v = isGoalPendingPromotion("m-sol-1", goals);
  assert.equal(v.pending, false);
});

test("isGoalPendingPromotion: standalone spec (milestone_id null) → pending:false (never suppressed)", () => {
  const goals = [goal({ slug: "sol", milestones: [{ id: "m-sol-1" }], main_merge_sha: null })];
  assert.equal(isGoalPendingPromotion(null, goals).pending, false);
  assert.equal(isGoalPendingPromotion(undefined, goals).pending, false);
});

test("isGoalPendingPromotion: milestone_id present but not in any known goal → pending:false (fail-safe; never suppress real drift)", () => {
  const goals = [goal({ slug: "sol", milestones: [{ id: "m-sol-1" }], main_merge_sha: null })];
  assert.equal(isGoalPendingPromotion("m-unknown", goals).pending, false);
});

test("isGoalPendingPromotion: empty goals list → pending:false (listGoals read failure fell back to [])", () => {
  assert.equal(isGoalPendingPromotion("m-sol-1", []).pending, false);
});

test("isGoalPendingPromotion: correct goal picked when multiple goals + multiple milestones present", () => {
  const goals = [
    goal({ slug: "sol", milestones: [{ id: "m-sol-1" }, { id: "m-sol-2" }], main_merge_sha: null }),
    goal({ slug: "luna", milestones: [{ id: "m-luna-1" }], main_merge_sha: "shipped" }),
  ];
  assert.equal(isGoalPendingPromotion("m-sol-2", goals).goalSlug, "sol");
  assert.equal(isGoalPendingPromotion("m-sol-2", goals).pending, true);
  assert.equal(isGoalPendingPromotion("m-luna-1", goals).pending, false);
});
