/**
 * Pins the status-aware refusal predicate for
 * [[../../docs/brain/specs/a-declined-renewal-must-not-wedge-the-cycle-forever]] Phase 1.
 *
 * `isReclaimable` is a pure predicate factored out of `claimCycleCharge` — it decides whether a
 * prior claim row for the same (subscription_id, cycle_key) can be atomically taken over by a
 * new claimant. The wedge case the spec fixes is the ground-truth sub e4e3b82e: one row,
 * `cycle_key=2026-10-04 status=failed`, claimed 2026-09-09 — every retry derived the same key
 * and was refused. After this phase, that shape MUST reclaim.
 *
 * The four states we assert here are the exact refusal-vs-reclaim boundary the code has to
 * hold:
 *   - `succeeded`        → refuse (money already moved)
 *   - fresh `in_flight`  → refuse (a concurrent attempt may still land)
 *   - stale `in_flight`  → reclaim as `stale_in_flight` (crashed prior attempt)
 *   - `failed`           → reclaim as `failed` (no money moved)
 *
 * Run:
 *   npx tsx --test src/lib/subscription-cycle-charge-claim.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  STALE_IN_FLIGHT_RECLAIM_MS,
  cycleKeyFromDispatchedNextBillingDate,
  isReclaimable,
  renewalRefusalOutcomeLabel,
  type CycleChargeRow,
} from "./subscription-cycle-charge-claim";

function priorRow(overrides: Partial<Pick<CycleChargeRow, "status" | "claimed_at">>) {
  return { status: "in_flight" as const, claimed_at: new Date().toISOString(), ...overrides };
}

test("succeeded never reclaims — the money moved", () => {
  const NOW = 1_800_000_000_000;
  const prior = priorRow({ status: "succeeded", claimed_at: new Date(NOW - 60_000).toISOString() });
  assert.equal(isReclaimable(prior, NOW), null);
});

test("fresh in_flight refuses — a concurrent attempt may still land", () => {
  const NOW = 1_800_000_000_000;
  const prior = priorRow({
    status: "in_flight",
    claimed_at: new Date(NOW - (STALE_IN_FLIGHT_RECLAIM_MS - 1_000)).toISOString(),
  });
  assert.equal(isReclaimable(prior, NOW), null);
});

test("stale in_flight REFUSES — a crashed prior attempt may have settled a Braintree sale before the worker died, so auto-reclaim would double-charge (Fix 1 of a-declined-renewal-must-not-wedge-the-cycle-forever). A stranded in_flight requires an explicit reconciliation/repair path that proves no external Braintree charge settled before any retry; visibility comes from the Control Tower renewal-wedged-cycles assertion, not from auto-reset.", () => {
  const NOW = 1_800_000_000_000;
  const prior = priorRow({
    status: "in_flight",
    claimed_at: new Date(NOW - (STALE_IN_FLIGHT_RECLAIM_MS + 1_000)).toISOString(),
  });
  assert.equal(isReclaimable(prior, NOW), null);
});

test("failed reclaims — the wedge case sub e4e3b82e / cycle_key=2026-10-04", () => {
  const NOW = new Date("2026-10-04T12:00:00Z").getTime();
  const prior = priorRow({ status: "failed", claimed_at: "2026-09-09T12:00:00Z" });
  const verdict = isReclaimable(prior, NOW);
  assert.deepEqual(verdict, { reason: "failed" });
});

test("stale threshold constant is at least a minute — reviewers can widen without a code hunt", () => {
  assert.ok(
    STALE_IN_FLIGHT_RECLAIM_MS >= 60_000,
    "STALE_IN_FLIGHT_RECLAIM_MS must be > 1 minute; a Braintree sale can genuinely take that long",
  );
});

// ── Phase 2 — refusal outcome label split ────────────────────────────
// A refusal whose existing claim is `succeeded` is benign (the real charge already resolved
// this cycle) and stays under `skipped_other`. A refusal on any other status means a
// customer cannot be billed for THIS cycle and must be distinguishable so the outcome-
// distribution assertion can alert on it instead of blending into skip volume.
test("succeeded refusal → skipped_other (benign, no double-alert)", () => {
  assert.equal(renewalRefusalOutcomeLabel("succeeded"), "skipped_other");
});

test("in_flight refusal → refused_wedged_cycle (alertable)", () => {
  assert.equal(renewalRefusalOutcomeLabel("in_flight"), "refused_wedged_cycle");
});

test("failed refusal (CAS-race fall-through) → refused_wedged_cycle (alertable)", () => {
  // A `failed` row is normally reclaimed by the SDK; the only way this branch reaches the
  // refusal is a CAS race where the reset lost. That is exactly the case that needs to
  // surface — the row is still on the ledger AND the customer cannot be billed.
  assert.equal(renewalRefusalOutcomeLabel("failed"), "refused_wedged_cycle");
});

// ── Phase 1 — pin cycle_key to the dispatched cycle, not to live state ──
// docs/brain/specs/a-renewal-cycle-key-must-not-derive-from-a-field-the-charge-moves.md
//
// Ground truth: sub e9b8a6d9 claimed cycle_key 2026-10-30 at 15:30:46.79 for $108.01 and
// 2026-12-25 at 15:30:55.20 for $140.28 — eight seconds apart, both real Braintree sales.
// The pre-charge next_billing_date for the reactivation was 2026-10-30 (T1). A successful
// renewal advances it to 2026-12-25 (T2). Concurrent attempt B reads AFTER attempt A has
// advanced the field, computes T2 as its cycle_key, does not collide with A's T1 claim,
// and both charge. Pinning the derivation to the DISPATCHED value (`expected_next_billing_date`
// stamped by the dispatcher onto the attempt event) makes both attempts compute the SAME
// key so the unique index refuses the second.
const GROUND_TRUTH_PRE_CHARGE = "2026-10-30";
const GROUND_TRUTH_POST_ADVANCE = "2026-12-25";

test("Phase 1: concurrent attempts for the SAME reactivation collide on the same key (ground truth: sub e9b8a6d9)", () => {
  const attemptA = cycleKeyFromDispatchedNextBillingDate(GROUND_TRUTH_PRE_CHARGE);
  const attemptB = cycleKeyFromDispatchedNextBillingDate(GROUND_TRUTH_PRE_CHARGE);
  assert.equal(attemptA, "2026-10-30");
  assert.equal(attemptB, "2026-10-30");
  assert.equal(attemptA, attemptB);
});

test("Phase 1: the ground-truth bug — deriving from live state after the first attempt advanced next_billing_date computes DIFFERENT keys", () => {
  // This test PINS the bug shape. If both attempts derive from what the SUB'S FIELD reads at
  // the moment they run — attempt A reads T1 (pre-charge), attempt B reads T2 (after A
  // advanced it) — the keys diverge and both claim cleanly. The dispatched-cycle derivation
  // above is what forces them together.
  const attemptA = cycleKeyFromDispatchedNextBillingDate(GROUND_TRUTH_PRE_CHARGE);
  const attemptBFromLiveState = cycleKeyFromDispatchedNextBillingDate(GROUND_TRUTH_POST_ADVANCE);
  assert.equal(attemptA, "2026-10-30");
  assert.equal(attemptBFromLiveState, "2026-12-25");
  assert.notEqual(attemptA, attemptBFromLiveState);
});

test("Phase 1: a missing dispatched cycle returns null so the caller MUST refuse (no live-state fallback)", () => {
  // The fallback to a live read is EXACTLY the hole the spec closes. If the dispatcher
  // failed to stamp the cycle, the caller has no honest way to identify which cycle the
  // attempt is for — refusing is the safe answer.
  assert.equal(cycleKeyFromDispatchedNextBillingDate(null), null);
  assert.equal(cycleKeyFromDispatchedNextBillingDate(undefined), null);
  assert.equal(cycleKeyFromDispatchedNextBillingDate(""), null);
});

test("Phase 1: an unparseable dispatched cycle returns null (never coalesce to a garbage constant that would collide across subs)", () => {
  assert.equal(cycleKeyFromDispatchedNextBillingDate("not-a-date"), null);
  assert.equal(cycleKeyFromDispatchedNextBillingDate("2026-13-40"), null);
});

test("Phase 1: cycle_key is the UTC date slice (concurrent triggers on the same day pin to the same key regardless of hh:mm:ss)", () => {
  assert.equal(
    cycleKeyFromDispatchedNextBillingDate("2026-10-30T15:30:46.79Z"),
    "2026-10-30",
  );
  assert.equal(
    cycleKeyFromDispatchedNextBillingDate("2026-10-30T23:59:59.999Z"),
    "2026-10-30",
  );
});
