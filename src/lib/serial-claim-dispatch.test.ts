/**
 * goal-serializer-one-decision-point-and-serial-claim-no-queued-deadlock Phase 2 —
 * serial claim-and-decide predicate.
 *
 * Pins the NAMED failing state from the spec's Verification: the box worker used to fire per-kind
 * `claim_agent_job` RPCs that filled every free build lane in one poll tick, then let the gate fire
 * INSIDE runJob (after Max sessions had already spun up). Two same-goal same-priority mates got
 * claimed in the same tick and mutually blocked (the amplifier of the 2026-07-16 dahlia deadlock).
 *
 * Post-fix contract: after each `claim_agent_job` return, the loop invokes
 * `decideSerialClaimDispatchOutcome` inline with the just-fetched `evaluateGoalMemberBuildDispatch`
 * verdict, and only advances to the next claim once the disposition is settled. A refused verdict
 * releases the row back to `queued` (not cancelled, not lost — the RPC's cooldown lets it be
 * re-picked next window). A resume / non-build kind / no-slug / evaluator throw all fail OPEN
 * (`launch`) so the claim-time gate inside `runJob` remains the last line of defense.
 *
 * When two same-goal mates land in adjacent iterations of the loop, the SECOND call to
 * `evaluateGoalMemberBuildDispatch` reads the FIRST as in-flight and refuses — so the classifier
 * naturally lets exactly one launch and releases the rest. That per-pass "one-goal-mate-launches"
 * invariant is enforced by this predicate + the serial-ness of the awaited claim loop.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/serial-claim-dispatch.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideSerialClaimDispatchOutcome,
  type SerialClaimDispatchVerdict,
} from "./agent-jobs";

function input(overrides: {
  kind?: string;
  isResume?: boolean;
  specSlug?: string | null;
  dispatchVerdict?: SerialClaimDispatchVerdict;
} = {}) {
  return {
    kind: overrides.kind ?? "build",
    isResume: overrides.isResume ?? false,
    specSlug: overrides.specSlug ?? "some-spec",
    dispatchVerdict: overrides.dispatchVerdict ?? { ok: true },
  };
}

test("dispatch ok → launch (baseline: an admitted goal-member spawns its Max session)", () => {
  const outcome = decideSerialClaimDispatchOutcome(input({ dispatchVerdict: { ok: true } }));
  assert.deepEqual(outcome, { action: "launch" });
});

test("dispatch refused → release with the serializer's reason (not-admitted goal-mate)", () => {
  const reason = "another goal-member build is in-flight for goal dahlia-...; serialized to prevent hot-file collisions";
  const outcome = decideSerialClaimDispatchOutcome(input({ dispatchVerdict: { ok: false, reason } }));
  assert.deepEqual(outcome, { action: "release", reason });
});

test("dispatch refused with no reason → release carries a placeholder reason (never launches)", () => {
  const outcome = decideSerialClaimDispatchOutcome(input({ dispatchVerdict: { ok: false } }));
  assert.equal(outcome.action, "release");
  if (outcome.action === "release") assert.match(outcome.reason, /no reason provided/);
});

test("resume (session id set) → launch bypasses the serializer (committed WIP)", () => {
  // Mirrors the claim-time gate at scripts/builder-worker.ts:~6010 — a resume is committed WIP
  // (its branch/PR already exists), so re-gating it would strand work. The classifier bypasses
  // even when a dispatch verdict was somehow fetched.
  const outcome = decideSerialClaimDispatchOutcome(
    input({ isResume: true, dispatchVerdict: { ok: false, reason: "would refuse fresh claim" } }),
  );
  assert.deepEqual(outcome, { action: "launch" });
});

test("non-build kind → launch (plan / other kinds don't goal-serialize)", () => {
  // `plan` shares the pool but has no goal-member serialization semantics — its DB call would
  // resolve as not-goal-bound and return ok:true anyway; the classifier bypasses to skip the
  // round trip.
  const outcome = decideSerialClaimDispatchOutcome(
    input({ kind: "plan", dispatchVerdict: { ok: false, reason: "would-never-happen" } }),
  );
  assert.deepEqual(outcome, { action: "launch" });
});

test("no spec slug → launch (nothing to resolve to a goal)", () => {
  const outcome = decideSerialClaimDispatchOutcome(input({ specSlug: null, dispatchVerdict: null }));
  assert.deepEqual(outcome, { action: "launch" });
});

test("null verdict → launch (evaluator threw / skipped — fail open, claim-time gate still guards)", () => {
  // The caller passes `null` when it caught an error before it could fetch a verdict; the
  // classifier MUST fail open so a transient DB flake never wedges the whole build pool.
  const outcome = decideSerialClaimDispatchOutcome(input({ dispatchVerdict: null }));
  assert.deepEqual(outcome, { action: "launch" });
});

test("two same-goal mates seen serially → the second's already-in-flight refusal releases", () => {
  // The loop's per-pass invariant: mate A is fetched first, its dispatch returns ok, it launches.
  // Mate B is fetched next (same tick), its dispatch sees A now in-flight (via
  // GOAL_INFLIGHT_STATUSES) and returns ok:false. The classifier releases B — exactly one launch
  // per pass, without ever having claimed both concurrently.
  const outcomeA = decideSerialClaimDispatchOutcome({
    kind: "build",
    isResume: false,
    specSlug: "a-spec",
    dispatchVerdict: { ok: true },
  });
  assert.deepEqual(outcomeA, { action: "launch" });
  const outcomeB = decideSerialClaimDispatchOutcome({
    kind: "build",
    isResume: false,
    specSlug: "b-spec",
    dispatchVerdict: {
      ok: false,
      reason: "another goal-member build is in-flight for goal some-goal (a-spec status=building); serialized to prevent hot-file collisions",
    },
  });
  assert.equal(outcomeB.action, "release");
  if (outcomeB.action === "release") assert.match(outcomeB.reason, /a-spec/);
});
