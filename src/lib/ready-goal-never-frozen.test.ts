/**
 * goal-serializer-one-decision-point-and-serial-claim-no-queued-deadlock Phase 3 —
 * ready-goal-never-frozen invariant + dahlia deadlock regression.
 *
 * Pins the NAMED failing state from the 2026-07-16 dahlia stall: the earliest ready head of goal
 * `dahlia-imitate-then-innovate-copy-engine` had no in-flight build row while a later goal-mate
 * was `queued` — a persistent deadlock that today required a manual unwedge (cancel the
 * mis-prioritized queued job, re-enqueue the head). Phase 3 elevates that manual fix to a
 * standing invariant + auto-break: any ready goal with an earliest head that has NO row (not
 * queued, not building) is flagged 'deadlock' and the auto-break dispatches the earliest.
 *
 * `checkReadyGoalNeverFrozenInvariant` is the pure predicate exercised here — it takes the goal's
 * member DAG + the current in-flight goal-mate rows (any active status incl. queued) and returns
 * `{ verdict: 'deadlock', earliest }` iff a Kahn head has no in-flight row at all; else
 * `{ verdict: 'ok', reason }`. The async wrapper `assertReadyGoalNeverFrozenAndAutoBreak` reads
 * the DB state and fires `autoBreakGoalMemberDeadlockIfDue` on 'deadlock' (its own cooldown
 * dedupes rapid re-checks).
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/ready-goal-never-frozen.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkReadyGoalNeverFrozenInvariant,
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

test("dahlia regression — head has no row while a later member is queued: verdict='deadlock' + earliest=head", () => {
  // The exact 2026-07-16 dahlia state. `dahlia-head` (the earliest Kahn ready mate) has NO
  // row in the inflight set. A later mate (`dahlia-deeper-competitor-selection`) is `queued` —
  // but because the head is missing entirely, this goal is deadlocked (the dispatcher can only
  // admit the earliest, and there's nothing to claim for it).
  const members = [
    m("dahlia-head"),
    m("dahlia-deeper-competitor-selection", { blockedBy: ["dahlia-head"] }),
  ];
  const inflight: GoalMemberInflightRow[] = [
    { slug: "dahlia-deeper-competitor-selection", status: "queued" },
  ];
  const decision = checkReadyGoalNeverFrozenInvariant({ members, inflight });
  assert.deepEqual(decision, { verdict: "deadlock", earliest: "dahlia-head" });
});

test("invariant returns 'ok' when the earliest head is queued (dispatcher will admit it next tick)", () => {
  // Healthy Phase 1+2 state: the head has a `queued` row waiting for its claim. Not a
  // deadlock — the serial claim-and-decide step will admit it on the next tick.
  const members = [m("a-spec"), m("b-spec")];
  const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status: "queued" }];
  const decision = checkReadyGoalNeverFrozenInvariant({ members, inflight });
  assert.equal(decision.verdict, "ok");
  if (decision.verdict === "ok") assert.match(decision.reason, /head-in-flight/);
});

test("invariant returns 'ok' when the earliest head is building (serializer working)", () => {
  const members = [m("a-spec"), m("b-spec")];
  const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status: "building" }];
  const decision = checkReadyGoalNeverFrozenInvariant({ members, inflight });
  assert.equal(decision.verdict, "ok");
  if (decision.verdict === "ok") assert.match(decision.reason, /head-in-flight/);
});

test("invariant returns 'ok' when there is no ready head (every mate has an unbuilt blocker)", () => {
  // Nothing to advance — every mate still has a goal-mate blocker unbuilt. Not a deadlock; the
  // caller can't do anything productive here even if we said 'deadlock' (the auto-break would
  // find no ready head and no-op).
  const members = [
    m("a-spec", { blockedBy: ["b-spec"] }),
    m("b-spec", { blockedBy: ["a-spec"] }),
  ];
  const decision = checkReadyGoalNeverFrozenInvariant({ members, inflight: [] });
  assert.equal(decision.verdict, "ok");
});

test("invariant returns 'ok' when every mate is shipped/folded/on-goal-branch (nothing to build)", () => {
  const members = [
    m("a-spec", { onGoalBranch: true }),
    m("b-spec", { status: "shipped" }),
    m("c-spec", { status: "folded" }),
  ];
  const decision = checkReadyGoalNeverFrozenInvariant({ members, inflight: [] });
  assert.equal(decision.verdict, "ok");
});

test("invariant returns 'deadlock' + earliest when a NON-earliest race artifact is in-flight", () => {
  // The 2026-07-12 livelock signature — several mates flipped to `building` in one sweep. The
  // TRUE earliest (`control-tower-switch`) is not in the inflight set. Invariant flags this as a
  // deadlock even though the box looks busy — the busyness is race artifacts, not the head.
  const members = [
    m("control-tower-switch"),
    m("orphan-node"),
    m("message-center"),
  ];
  const inflight: GoalMemberInflightRow[] = [
    { slug: "orphan-node", status: "building" },
    { slug: "message-center", status: "queued" },
  ];
  const decision = checkReadyGoalNeverFrozenInvariant({ members, inflight });
  assert.deepEqual(decision, { verdict: "deadlock", earliest: "control-tower-switch" });
});

test("invariant returns 'ok' for the degenerate empty-members goal (race safety)", () => {
  const decision = checkReadyGoalNeverFrozenInvariant({ members: [], inflight: [] });
  assert.equal(decision.verdict, "ok");
});

test("the earliest field on 'deadlock' is the alphabetically-first Kahn ready head (deterministic)", () => {
  // A-spec + B-spec both have no blockers within the goal — both are Kahn heads. The invariant
  // picks the alphabetically-first (matches decideGoalMemberBuildDispatch's tiebreak) so a re-run
  // consistently reports the same earliest.
  const members = [m("b-spec"), m("a-spec"), m("c-spec")];
  const decision = checkReadyGoalNeverFrozenInvariant({ members, inflight: [] });
  assert.equal(decision.verdict, "deadlock");
  if (decision.verdict === "deadlock") assert.equal(decision.earliest, "a-spec");
});
