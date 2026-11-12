/**
 * box-serial-claim-cooldown-wedge-guard Phase 1 — pre-launch serial-claim decision.
 *
 * Pins the NAMED failing state the spec's Phase 1 fix protects against: the box's build/plan
 * claim loop must, on a held serial-claim verdict, release the row (write the future
 * claimed_at cooldown) and EXIT the poll pass so a broken live claim RPC can't re-claim the
 * same row on the same tick.
 *
 * The pure predicate is the atomic decision the poll loop keys off — given the goal-member
 * serializer's verdict, it returns `action: "dispatch" | "release"`. A one-off spec / a
 * member of a different goal has `serial.ok:true` and dispatches; a held goal-mate returns
 * `release` with the serializer's reason preserved for the log line + the cooldown update.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/serial-claim-dispatch-outcome.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideSerialClaimDispatchOutcome } from "./agent-jobs";
import { shouldDropSeriallyHeldGoalMember } from "./mario";

test("serial.ok:true → dispatch (one-off / independent goal-mate / cleared head)", () => {
  const outcome = decideSerialClaimDispatchOutcome({ serial: { ok: true } });
  assert.equal(outcome.action, "dispatch");
  assert.equal(outcome.reason, undefined);
});

test("serial.ok:false → release + preserves the serializer's reason (used as log/cooldown detail)", () => {
  const reason = "b-spec is not the earliest ready goal-member of some-goal (a-spec is next); serialized within the goal";
  const outcome = decideSerialClaimDispatchOutcome({ serial: { ok: false, reason } });
  assert.equal(outcome.action, "release");
  assert.equal(outcome.reason, reason, "the release branch surfaces the exact serializer verdict — that's what the caller cooldowns + logs");
});

test("named failing state: a held goal-mate never returns `dispatch` (the wedge invariant)", () => {
  // The invariant Phase 1 protects: a serializer verdict of ok:false MUST convert to `release`,
  // NEVER `dispatch`. If this ever flipped, the poll loop would launch a same-goal build the
  // gate holds — the collision the goal-member serializer was written to prevent.
  const serials: Array<{ ok: false; reason: string }> = [
    { ok: false, reason: "another goal-member build is in-flight for goal g1 (a-spec status=building); serialized to prevent hot-file collisions" },
    { ok: false, reason: "no goal-member of g1 has all goal-mate blockers on the goal branch this tick — held; escort re-releases next tick" },
    { ok: false, reason: "b-spec is not the earliest ready goal-member of g1 (a-spec is next); serialized within the goal" },
  ];
  for (const serial of serials) {
    const outcome = decideSerialClaimDispatchOutcome({ serial });
    assert.equal(outcome.action, "release", `held verdict "${serial.reason}" must map to release`);
  }
});

/**
 * mario-serializer-aware-drop-for-queued-goal-member-builds Phase 1 — the (d3) serializer-aware
 * legit-wait drop must now cover the QUEUED-BUILD sources (`job_queued` timecard-gap + `build_queued`
 * stuck-queued), not only the sixth `spec_authored` source. `shouldDropSeriallyHeldGoalMember` is the
 * pure predicate the detector loop keys off: dispatch.ok===false on any allowed source ⇒ drop.
 */
const HELD = { ok: false as const, reason: "widget-signed-identity-pass is not the earliest ready goal-member of shopgrowth-software-support (software-mode-orchestrator-toolset is next); serialized within the goal" };
const ADMISSIBLE = { ok: true as const };

test("named failing state: job_queued timecard-gap source now drops a serially-held queued member", () => {
  // The exact stall class the spec fixes — before this phase the gate was `spec_authored`-only, so
  // the job_queued→job_claimed 600 000 ms SLA surfaced a legitimately-serialized queued build as a
  // false stall and fired Mario every cycle.
  assert.equal(
    shouldDropSeriallyHeldGoalMember({ fromEvent: "job_queued", dispatch: HELD }),
    true,
    "a queued member the serializer is refusing (ok:false) off the job_queued source must drop",
  );
});

test("the seventh stuck-queued-build source (build_queued) also drops a serially-held queued member", () => {
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "build_queued", dispatch: HELD }), true);
});

test("spec_authored (sixth source) drop is preserved", () => {
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "spec_authored", dispatch: HELD }), true);
});

test("invariant: a truly-starved queued build (dispatch.ok:true — its turn has arrived) still SURFACES", () => {
  // The member whose turn has come, a one-off spec, or a member of a fully-admissible goal must NOT
  // be dropped — only ok:false (serialized behind another member) drops.
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "job_queued", dispatch: ADMISSIBLE }), false);
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "build_queued", dispatch: ADMISSIBLE }), false);
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "spec_authored", dispatch: ADMISSIBLE }), false);
});

test("invariant: a non-serializer source (failed build / pr-resolve-storm) is NEVER dropped by this filter", () => {
  // Those classes carry a real job/PR to act on; the serial-build gate does not apply even when a
  // serializer read would say ok:false.
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "build_started", dispatch: HELD }), false);
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "pr_resolve_storm", dispatch: HELD }), false);
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "orphaned_folded_pr", dispatch: HELD }), false);
});
