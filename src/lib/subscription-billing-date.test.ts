/**
 * Phase 2 of [[docs/brain/specs/a-subscription-is-never-more-than-one-cycle-behind]].
 *
 * Pins the correct behavior of `advanceToNextFutureBillingDate` against the failing
 * state named in the spec: a subscription several cycles behind, charging a single
 * cycle then having its next_billing_date land STILL in the past — re-picked by the
 * daily cron and charged again, one cycle per day, until it catches up. Two customers
 * were billed this way; one was owed a $179.70 refund.
 *
 *   npx tsx --test src/lib/subscription-billing-date.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { advanceToNextFutureBillingDate } from "./subscription-billing-date";

test("happy path: monthly sub charged on its billing day advances by one month", () => {
  const current = new Date("2026-09-24T00:00:00.000Z");
  const now = new Date("2026-09-24T15:30:00.000Z"); // same day, later in the day
  const next = advanceToNextFutureBillingDate(current, "month", 1, now);
  assert.equal(next.toISOString(), "2026-10-24T00:00:00.000Z");
});

test("backlog: monthly sub three cycles behind skips to next FUTURE cycle in ONE write (the whole point of Phase 2)", () => {
  // Current stored next_billing_date is 2026-06-24; the sub has been failing for three
  // months so it's now 2026-09-24. Under the old code, next = 2026-07-24 (STILL past),
  // and the daily cron would re-pick tomorrow. Under Phase 2, next = 2026-10-24
  // (strictly future), and the backlog is SKIPPED — not billed out at one-per-day.
  const current = new Date("2026-06-24T00:00:00.000Z");
  const now = new Date("2026-09-24T15:30:00.000Z");
  const next = advanceToNextFutureBillingDate(current, "month", 1, now);
  assert.equal(next.toISOString(), "2026-10-24T00:00:00.000Z");
});

test("day-of-cycle anchor is preserved across skipped backlog", () => {
  // 15-of-the-month sub, 5 months behind — still lands on the 15th, not a drifting day.
  const current = new Date("2026-04-15T00:00:00.000Z");
  const now = new Date("2026-09-24T15:30:00.000Z");
  const next = advanceToNextFutureBillingDate(current, "month", 1, now);
  assert.equal(next.toISOString(), "2026-10-15T00:00:00.000Z");
});

test("month-end anchor: Jan 31 monthly steps to Feb 28 (not Mar 3) and back to Mar 31", () => {
  // Naive setUTCMonth on Jan 31 overflows to Mar 3, and the drift compounds every step.
  // The pure helper anchors from ORIGINAL current + running months, clamping to the
  // target month's last day. Feb 28 → Mar 31 preserves the 31 intent.
  const janEnd = new Date("2026-01-31T00:00:00.000Z");
  const feb = advanceToNextFutureBillingDate(janEnd, "month", 1, new Date("2026-02-14T00:00:00.000Z"));
  assert.equal(feb.toISOString(), "2026-02-28T00:00:00.000Z");
  const mar = advanceToNextFutureBillingDate(janEnd, "month", 1, new Date("2026-03-14T00:00:00.000Z"));
  assert.equal(mar.toISOString(), "2026-03-31T00:00:00.000Z");
});

test("always advances at least once even when current is already in the future (portal order-now on a not-yet-due sub)", () => {
  // A portal 'order now' press can fire on a sub whose next_billing_date is already
  // future — the customer wanted the box early. After the charge, next_billing_date
  // must still move forward by one cycle; leaving it unchanged would double-bill on
  // the original scheduled date.
  const current = new Date("2026-10-15T00:00:00.000Z");
  const now = new Date("2026-09-24T15:30:00.000Z");
  const next = advanceToNextFutureBillingDate(current, "month", 1, now);
  assert.equal(next.toISOString(), "2026-11-15T00:00:00.000Z");
});

test("weekly cadence steps by 7*count days per step", () => {
  const current = new Date("2026-09-10T00:00:00.000Z");
  const now = new Date("2026-09-24T15:30:00.000Z");
  const next = advanceToNextFutureBillingDate(current, "week", 2, now);
  // 2026-09-10 + 14 days = 2026-09-24 (equal → not strictly future) → step again
  // = 2026-10-08.
  assert.equal(next.toISOString(), "2026-10-08T00:00:00.000Z");
});

test("day cadence with a large backlog skips forward one day at a time", () => {
  // Daily sub 5 days behind. Steps through all 5 skipped days and lands strictly future.
  const current = new Date("2026-09-19T00:00:00.000Z");
  const now = new Date("2026-09-24T15:30:00.000Z");
  const next = advanceToNextFutureBillingDate(current, "day", 1, now);
  assert.equal(next.toISOString(), "2026-09-25T00:00:00.000Z");
});

test("year cadence: annual sub anchor is preserved across years", () => {
  const current = new Date("2024-09-24T00:00:00.000Z");
  const now = new Date("2026-09-24T15:30:00.000Z");
  const next = advanceToNextFutureBillingDate(current, "year", 1, now);
  assert.equal(next.toISOString(), "2027-09-24T00:00:00.000Z");
});

test("count of 0 or negative normalizes to 1 (a malformed count is not permitted to spin)", () => {
  const current = new Date("2026-09-24T00:00:00.000Z");
  const now = new Date("2026-09-24T15:30:00.000Z");
  const next = advanceToNextFutureBillingDate(current, "day", 0, now);
  assert.equal(next.toISOString(), "2026-09-25T00:00:00.000Z");
});

test("unknown interval falls back to monthly cadence rather than a silent no-op", () => {
  const current = new Date("2026-09-24T00:00:00.000Z");
  const now = new Date("2026-09-24T15:30:00.000Z");
  const next = advanceToNextFutureBillingDate(current, "quarter", 1, now);
  assert.equal(next.toISOString(), "2026-10-24T00:00:00.000Z");
});

test("skipped cycles are NOT billed — the returned date is the ONLY thing written", () => {
  // Phase 2 invariant: skipping a backlog must NOT be recorded as those cycles having
  // been billed. This test pins the helper's contract — it returns ONE date; it does
  // not enumerate the skipped cycles anywhere. The caller (renewal cron) writes ONLY
  // that single date to subscriptions.next_billing_date and inserts NO extra rows to
  // subscription_cycle_charges for the skipped cycles.
  const current = new Date("2026-01-24T00:00:00.000Z");
  const now = new Date("2026-09-24T15:30:00.000Z");
  const next = advanceToNextFutureBillingDate(current, "month", 1, now);
  assert.equal(next.toISOString(), "2026-10-24T00:00:00.000Z");
});

test("throws (does not silently return a past date) if a malformed cadence exhausts the step cap", () => {
  // Fabricated: current is very far in the past AND now is even further in the future
  // than 520 daily steps can bridge. In real usage no legitimate sub is 520+ days
  // behind; a bad-forever write would be silently re-picked daily.
  const current = new Date("2020-01-01T00:00:00.000Z");
  const now = new Date("2030-01-01T00:00:00.000Z");
  assert.throws(
    () => advanceToNextFutureBillingDate(current, "day", 1, now),
    /advanceToNextFutureBillingDate_step_cap/,
  );
});
