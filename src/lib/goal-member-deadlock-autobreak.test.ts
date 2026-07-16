/**
 * parallel-build-serialized-merge-and-deadlock-autobreak Phase 1 — deadlock-detection predicate.
 *
 * Pins the NAMED failing state from the 2026-07-15 Bianca stall: the earliest ready head
 * ('cohort-and-ceiling') was NEVER enqueued, and every sibling behind it was claim-and-ejected by
 * `decideGoalMemberBuildDispatch` every tick. The pure predicate MUST recognize "earliest ready
 * head has no in-flight build row" as a deadlock signal (so the async wrapper auto-enqueues it)
 * — and MUST NOT fire when the earliest is legitimately in-flight (the serializer is working).
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/goal-member-deadlock-autobreak.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideGoalMemberDeadlockAutoBreak,
  type GoalMemberDispatchState,
  type GoalMemberInflightRow,
} from "./agent-jobs";

function m(slug: string, opts: Partial<GoalMemberDispatchState> = {}): GoalMemberDispatchState {
  return {
    slug,
    onGoalBranch: false,
    status: "planned",
    blockedBy: [],
    ...opts,
  };
}

test("earliest ready head has NO in-flight build → deadlock detected, auto-break fires", () => {
  // The 2026-07-15 Bianca shape: a-spec is the earliest ready head but was never enqueued;
  // b-spec is the sibling that's being claim-and-ejected every tick. Pre-fix: no auto-break,
  // the goal deadlocks forever. Post-fix: predicate says `deadlocked: true, earliest: 'a-spec'`
  // so the wrapper force-enqueues a-spec.
  const members = [m("a-spec"), m("b-spec"), m("c-spec")];
  const inflight: GoalMemberInflightRow[] = [{ slug: "b-spec", status: "queued" }];
  const decision = decideGoalMemberDeadlockAutoBreak({ members, inflight });
  assert.deepEqual(decision, { deadlocked: true, earliest: "a-spec" });
});

test("earliest ready head IS in-flight (any active status) → no auto-break (serializer working)", () => {
  // The healthy shape: a-spec (earliest) is `building`; b-spec / c-spec are held by the
  // serializer. Auto-break MUST NOT fire — the head owns the slot legitimately.
  const members = [m("a-spec"), m("b-spec"), m("c-spec")];
  const activeStatuses = ["queued", "queued_resume", "claimed", "building", "needs_input", "needs_approval", "blocked_on_usage"];
  for (const status of activeStatuses) {
    const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status }];
    const decision = decideGoalMemberDeadlockAutoBreak({ members, inflight });
    assert.equal(decision.deadlocked, false, `status=${status} should NOT trigger auto-break`);
    if (!decision.deadlocked) {
      assert.match(decision.reason, /head-in-flight/, `status=${status} reason should be head-in-flight`);
    }
  }
});

test("earliest is on the goal branch (already integrated) → predicate picks the next unbuilt head", () => {
  // a-spec merged onto the goal branch; b-spec is the new earliest head with no in-flight row.
  // Auto-break enqueues b-spec.
  const members = [
    m("a-spec", { onGoalBranch: true }),
    m("b-spec"),
    m("c-spec"),
  ];
  const inflight: GoalMemberInflightRow[] = [];
  const decision = decideGoalMemberDeadlockAutoBreak({ members, inflight });
  assert.deepEqual(decision, { deadlocked: true, earliest: "b-spec" });
});

test("all members shipped/folded/on-goal-branch → no auto-break (nothing to advance)", () => {
  const members = [
    m("a-spec", { onGoalBranch: true }),
    m("b-spec", { status: "shipped" }),
    m("c-spec", { status: "folded" }),
  ];
  const inflight: GoalMemberInflightRow[] = [];
  const decision = decideGoalMemberDeadlockAutoBreak({ members, inflight });
  assert.equal(decision.deadlocked, false);
  if (!decision.deadlocked) assert.match(decision.reason, /no-unbuilt-members/);
});

test("no ready head (every candidate has an unbuilt goal-mate blocker) → no auto-break", () => {
  // b-spec blocked_by a-spec, a-spec blocked_by b-spec (cycle-ish — neither is a Kahn head).
  // Predicate finds no ready head and MUST NOT auto-break (there is nothing to advance).
  const members = [
    m("a-spec", { blockedBy: ["b-spec"] }),
    m("b-spec", { blockedBy: ["a-spec"] }),
  ];
  const inflight: GoalMemberInflightRow[] = [];
  const decision = decideGoalMemberDeadlockAutoBreak({ members, inflight });
  assert.equal(decision.deadlocked, false);
  if (!decision.deadlocked) assert.match(decision.reason, /no-ready-head/);
});

test("earliest ready head is a blocker-cleared candidate, not the alphabetical first when blocked", () => {
  // b-spec blocked_by a-spec (a-spec is unbuilt, so b-spec is NOT ready). a-spec IS the head.
  // With no in-flight, auto-break picks a-spec.
  const members = [
    m("a-spec"),
    m("b-spec", { blockedBy: ["a-spec"] }),
  ];
  const inflight: GoalMemberInflightRow[] = [];
  const decision = decideGoalMemberDeadlockAutoBreak({ members, inflight });
  assert.deepEqual(decision, { deadlocked: true, earliest: "a-spec" });
});

test("empty member list (goal race) → no auto-break", () => {
  const decision = decideGoalMemberDeadlockAutoBreak({ members: [], inflight: [] });
  assert.equal(decision.deadlocked, false);
  if (!decision.deadlocked) assert.match(decision.reason, /no-members/);
});

test("non-earliest race artifact in-flight does NOT count as head-in-flight for a truly-stalled head", () => {
  // The 2026-07-12 livelock shape from Phase-1's own regression test: several mates flipped to
  // `building` in one sweep. control-tower-switch (earliest) is NOT among them → predicate MUST
  // still say `deadlocked: true, earliest: control-tower-switch`. This is the exact scenario the
  // pre-fix Bianca stall showed — a busy but WRONG in-flight set never counts as the head being
  // in-flight.
  const members = [m("control-tower-switch"), m("orphan-node"), m("message-center")];
  const inflight: GoalMemberInflightRow[] = [
    { slug: "orphan-node", status: "building" },
    { slug: "message-center", status: "queued" },
  ];
  const decision = decideGoalMemberDeadlockAutoBreak({ members, inflight });
  assert.deepEqual(decision, { deadlocked: true, earliest: "control-tower-switch" });
});
