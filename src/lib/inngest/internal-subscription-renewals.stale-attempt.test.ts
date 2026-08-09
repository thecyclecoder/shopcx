/**
 * Phase 1 of internal-renewal-skip-stale-attempts-before-dunning.
 *
 * Pins the stale-attempt boundary the guard at the top of the per-sub handler
 * uses. The cron fan-out stamps each attempt event with the sub's current
 * next_billing_date as `expected_next_billing_date`. When a duplicate/delayed
 * event arrives AFTER another attempt has already completed the cycle and
 * advanced the sub, the live next_billing_date won't match — the guard turns
 * that into a benign skip instead of re-charging + reopening dunning.
 *
 * Immediate-charge callers (portal order-now, appstle orderNowByContract,
 * payment-method recovery) intentionally send NO expected_next_billing_date;
 * the guard must leave them untouched.
 *
 * Pure function, no I/O — a direct import.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/internal-subscription-renewals.stale-attempt.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isRenewalAttemptStale } from "./internal-subscription-renewals";

const T1 = "2026-08-09T00:00:00Z";
const T2 = "2026-09-09T00:00:00Z"; // one cycle later

test("Phase 1: matching expected + actual next_billing_date is NOT stale (the normal path)", () => {
  assert.equal(isRenewalAttemptStale(T1, T1), false);
});

test("Phase 1: a moved-forward next_billing_date IS stale (another attempt already advanced)", () => {
  assert.equal(isRenewalAttemptStale(T1, T2), true);
});

test("Phase 1: a moved-backward next_billing_date is ALSO stale (fail-closed on any move)", () => {
  assert.equal(isRenewalAttemptStale(T2, T1), true);
});

test("Phase 1: an event with NO expected_next_billing_date passes through (immediate-charge callers)", () => {
  assert.equal(isRenewalAttemptStale(null, T1), false);
  assert.equal(isRenewalAttemptStale(undefined, T1), false);
});

test("Phase 1: no live actual next_billing_date does NOT force stale (defensive — never over-hold)", () => {
  assert.equal(isRenewalAttemptStale(T1, null), false);
  assert.equal(isRenewalAttemptStale(T1, undefined), false);
});

test("Phase 1: unparseable date strings on either side pass through (never over-hold)", () => {
  assert.equal(isRenewalAttemptStale("not-a-date", T1), false);
  assert.equal(isRenewalAttemptStale(T1, "not-a-date"), false);
});

test("Phase 1: differing ISO representations of the SAME instant are NOT stale (equality by ms)", () => {
  // Same instant, different serialization
  assert.equal(
    isRenewalAttemptStale("2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00Z"),
    false,
  );
});
