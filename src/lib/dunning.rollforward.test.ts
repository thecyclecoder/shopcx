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

// ── Cases the first pass missed, found by review ──────────────────────────────

// ⚠️ Naive `setMonth` OVERFLOWS: Jan 31 + 1 month = Mar 3, and the drift compounds every step.
// Measured before the fix: 2026-01-31 → 2026-10-03. 6 live monthly subs are anchored on day >= 29.
test("month-end anchors clamp instead of overflowing", () => {
  // Sept has 30 days, so a 31st anchor clamps to the 30th — it does NOT slide into October.
  const out = rollForwardToFutureBillingDate(new Date("2026-01-31T08:00:00Z"), "month", 1, NOW);
  assert.equal(out.toISOString(), "2026-09-30T08:00:00.000Z");
});

// ⭐ The property that matters: clamping must not DRIFT. Naive `setMonth` on a running value turns
// Jan 31 into Mar 3 and loses a day every short month; stepping from the ORIGIN means a clamped
// month is forgotten and the anchor returns intact in the next long one.
test("a clamped month does not permanently move the anchor", () => {
  const base = new Date("2026-01-31T08:00:00Z");
  const sept = rollForwardToFutureBillingDate(base, "month", 1, NOW);
  assert.equal(sept.getUTCDate(), 30, "clamped in a 30-day month");
  const oct = rollForwardToFutureBillingDate(base, "month", 1, new Date("2026-10-01T00:00:00Z"));
  assert.equal(oct.getUTCDate(), 31, "anchor RESTORED in a 31-day month, not stuck at 30");
});

test("a 30th anchor survives February", () => {
  const out = rollForwardToFutureBillingDate(new Date("2026-01-30T08:00:00Z"), "month", 1, NOW);
  assert.equal(out.toISOString(), "2026-09-30T08:00:00.000Z");
  assert.equal(out.getUTCDate(), 30);
});

test("a Feb-29 anchor lands on a real date", () => {
  const out = rollForwardToFutureBillingDate(new Date("2024-02-29T08:00:00Z"), "month", 1, NOW);
  assert.ok(out.getTime() > NOW.getTime());
  assert.ok(out.getUTCDate() <= 29);
});

// ⚠️ The cap must not return a PAST date. Silently doing so is worse than throwing: the caller
// writes it locally, Shopify rejects it, and the renewal cron re-selects that sub daily while never
// resolving a cycle — charged never, silently.
test("exhausting the iteration cap throws rather than returning a past date", () => {
  assert.throws(
    () => rollForwardToFutureBillingDate(new Date("1900-01-01T00:00:00Z"), "day", 1, NOW),
    /could not reach a future date/,
  );
});

// ⭐ Regression pin. The entire safety argument for the ~2,000 live Appstle subs is that the
// `recovered: true` branch (baseDate = now) is a NO-OP through this function.
test("recovered-path dates are returned untouched (no-op pin)", () => {
  const base = new Date(NOW.getTime() + 28 * 86_400_000);
  assert.equal(rollForwardToFutureBillingDate(base, "week", 4, NOW).toISOString(), base.toISOString());
});

test("a date exactly equal to now advances one whole interval", () => {
  const out = rollForwardToFutureBillingDate(new Date(NOW), "week", 4, NOW);
  assert.equal(out.toISOString(), new Date(NOW.getTime() + 28 * 86_400_000).toISOString());
});

// ⭐ The renewal worker's advance. Shopify anchors a contract's cycle calendar to its createdAt,
// so a MIGRATED contract charges early inside cycle 1 and that cycle's END is most of an extra
// interval away. Measured on 35945087149: charged 2026-09-11, next cycle ended 2026-12-31 — a
// 111-day gap on a 56-day cadence, i.e. ~one whole interval of revenue deferred per migrated sub.
// Advancing by the customer's own cadence from the date they were DUE is what keeps them on rhythm.
test("advancing by cadence keeps a migrated sub on its own schedule, not Shopify's calendar", () => {
  const due = new Date("2026-09-11T14:29:00Z");
  const out = rollForwardToFutureBillingDate(due, "week", 8, new Date("2026-09-11T14:30:00Z"));
  assert.equal(out.toISOString().slice(0, 10), "2026-11-06", "56 days on, not the cycle end (2026-12-31)");
});

// A LATE charge must not drag the customer's whole schedule forward: anchor to the scheduled date,
// then roll by WHOLE intervals to the next future occurrence on that same rhythm.
test("a late charge keeps the original anchor rather than restarting from now", () => {
  const out = rollForwardToFutureBillingDate(
    new Date("2026-07-01T08:00:00Z"), "week", 8, new Date("2026-09-11T14:30:00Z"),
  );
  assert.equal(out.toISOString().slice(0, 10), "2026-10-21");
  const daysFromAnchor = Math.round((out.getTime() - new Date("2026-07-01T08:00:00Z").getTime()) / 86_400_000);
  assert.equal(daysFromAnchor % 56, 0, "must land on a multiple of the cadence from the original anchor");
});
