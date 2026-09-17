/**
 * The cycle calendar can only be aimed at CREATE, via `billingPolicy.anchors`.
 *
 * Shopify computes cycles as `createdAt + n × interval` and that calendar is immutable afterwards:
 *   · `setNextBillingDate` moves only the display field — verified live, cycles unchanged.
 *   · `subscriptionBillingCycleScheduleEdit` refuses any date outside a cycle's own window
 *     (userError OUT_OF_BOUNDS), so it can delay an order but cannot re-phase the schedule.
 *
 * Without an anchor a migrated contract's cycles fall on its MIGRATION date, losing the customer's
 * billing day — and the cadence-advanced date can land inside the cycle already billed, which the
 * renewal worker reads as `cycle_already_billed` and skips forever. Measured on the 2026-09-16
 * cohort: 2 of 3 subs were silently dead one renewal after their first successful charge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorsForSchedule } from "./shopify-subscription-migrate";

test("a monthly sub is anchored to its day of month", () => {
  assert.deepEqual(
    anchorsForSchedule("MONTH", "2026-09-20T16:00:00Z"),
    { anchors: [{ type: "MONTHDAY", day: 20 }] },
  );
});

test("days 29-31 are deliberately NOT anchored", () => {
  // An anchor of 31 has no meaning in a 30-day month; falling back to the createdAt calendar is
  // today's behaviour, which is a known quantity rather than a new one discovered in production.
  for (const d of ["2026-01-29", "2026-01-30", "2026-01-31"]) {
    assert.deepEqual(anchorsForSchedule("MONTH", `${d}T16:00:00Z`), {}, `${d} must not anchor`);
  }
  assert.deepEqual(anchorsForSchedule("MONTH", "2026-01-28T16:00:00Z"), { anchors: [{ type: "MONTHDAY", day: 28 }] });
});

test("a weekly sub anchors on Shopify's weekday numbering, not JS's", () => {
  // JS Sunday = 0; Shopify Monday = 1 … Sunday = 7. Passing the JS value straight through would
  // send day:0, which is not a valid weekday.
  assert.deepEqual(anchorsForSchedule("WEEK", "2026-09-20T12:00:00Z"), { anchors: [{ type: "WEEKDAY", day: 7 }] }); // a Sunday
  assert.deepEqual(anchorsForSchedule("WEEK", "2026-09-21T12:00:00Z"), { anchors: [{ type: "WEEKDAY", day: 1 }] }); // Monday
});

test("an absent or unparseable date yields no anchor rather than a bad one", () => {
  assert.deepEqual(anchorsForSchedule("MONTH", null), {});
  assert.deepEqual(anchorsForSchedule("MONTH", "not-a-date"), {});
  assert.deepEqual(anchorsForSchedule("YEAR", "2026-09-20T16:00:00Z"), {});
});
