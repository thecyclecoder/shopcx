import { test } from "node:test";
import assert from "node:assert/strict";
import { rollForwardToFutureBillingDate } from "@/lib/dunning";

const NOW = new Date("2026-09-10T12:00:00Z");

test("a future date is returned untouched", () => {
  const base = new Date("2026-10-01T08:00:00Z");
  assert.equal(rollForwardToFutureBillingDate(base, "month", 1, NOW).toISOString(), base.toISOString());
});

// ⭐ The case that matters. Dunning's exhaustion path computes `original_billing_date + one
// interval`; for a cycle that ran for weeks that lands in the PAST, and Shopify rejects a past
// next-billing-date outright ("Next billing date is invalid", verified 2026-09-10).
test("a past date rolls forward to the future, keeping the cadence anchor", () => {
  const base = new Date("2026-07-01T08:00:00Z");
  const out = rollForwardToFutureBillingDate(base, "month", 1, NOW);
  assert.ok(out.getTime() > NOW.getTime(), "must land in the future");
  assert.equal(out.getUTCDate(), 1, "still the 1st — not clamped to 'tomorrow'");
  assert.equal(out.toISOString(), "2026-10-01T08:00:00.000Z");
});

test("a 4-week cadence keeps its day-of-week anchor", () => {
  const base = new Date("2026-06-04T08:00:00Z");
  const out = rollForwardToFutureBillingDate(base, "week", 4, NOW);
  assert.ok(out.getTime() > NOW.getTime());
  assert.equal(out.getUTCDay(), base.getUTCDay());
});

test("a malformed interval is bounded, never an infinite loop", () => {
  const out = rollForwardToFutureBillingDate(new Date("2020-01-01T00:00:00Z"), "fortnight", 1, NOW);
  assert.ok(out instanceof Date);
  assert.ok(out.getTime() > NOW.getTime(), "falls back to month stepping");
});
