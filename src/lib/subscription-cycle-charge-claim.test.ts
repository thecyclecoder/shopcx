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
  isReclaimable,
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

test("stale in_flight reclaims — a crashed prior attempt is not a permanent block", () => {
  const NOW = 1_800_000_000_000;
  const prior = priorRow({
    status: "in_flight",
    claimed_at: new Date(NOW - (STALE_IN_FLIGHT_RECLAIM_MS + 1_000)).toISOString(),
  });
  const verdict = isReclaimable(prior, NOW);
  assert.deepEqual(verdict, { reason: "stale_in_flight" });
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
