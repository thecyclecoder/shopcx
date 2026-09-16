/**
 * The advance must anchor to the date the customer was DUE, never to the clamped cycle selector.
 *
 * Two different dates are in play when a ShopCX renewal runs:
 *
 *   selectorDate — clamped forward to just inside the contract's first cycle, because Shopify
 *                  rejects a selector date before `createdAt`. Correct for CHOOSING the cycle.
 *   scheduledFor — `subscriptions.next_billing_date`, the date the customer was actually due.
 *
 * A MIGRATED contract is created today while the customer may already be overdue, so the clamp
 * fires for anyone due on or before migration day — the normal case, not an edge case. Using the
 * clamp as the advance anchor shifts their anniversary forward by however overdue they were, and
 * it compounds on every renewal.
 *
 * Measured live 2026-09-16: cohort sub 36018618541, due 09-12 on a 2-month cadence, advanced to
 * 11-15 instead of 11-12 — a 3-day loss, because its due date preceded the contract's createdAt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rollForwardToFutureBillingDate } from "../dunning";

const SRC = readFileSync(join(__dirname, "shopify-subscription-renewals.ts"), "utf8");

test("the drift is real arithmetic, not a rounding artifact", () => {
  // The exact cohort case: due 09-12, contract created 09-15, 2-month cadence.
  const trueDue = new Date("2026-09-12T16:51:38Z");
  const clamped = new Date("2026-09-15T16:51:39Z"); // createdAt + 1s
  const fromTrue = rollForwardToFutureBillingDate(trueDue, "month", 2);
  const fromClamp = rollForwardToFutureBillingDate(clamped, "month", 2);
  assert.notEqual(
    fromTrue.toISOString().slice(0, 10),
    fromClamp.toISOString().slice(0, 10),
    "anchoring to the clamp must produce a DIFFERENT date — that difference is the customer's lost days",
  );
  assert.equal(fromTrue.toISOString().slice(0, 10), "2026-11-12");
  assert.equal(fromClamp.toISOString().slice(0, 10), "2026-11-15");
});

test("the loss compounds across renewals", () => {
  // Three cycles anchored to the clamp drift three times; anchored to the schedule, never.
  let scheduled = new Date("2026-09-12T00:00:00Z");
  let drifting = new Date("2026-09-12T00:00:00Z");
  for (let i = 0; i < 3; i++) {
    scheduled = rollForwardToFutureBillingDate(scheduled, "month", 2);
    // simulate a 3-day-late charge each cycle, anchored to "when we charged" instead
    drifting = rollForwardToFutureBillingDate(
      new Date(drifting.getTime() + 3 * 86400000), "month", 2,
    );
  }
  const lostDays = Math.round((drifting.getTime() - scheduled.getTime()) / 86400000);
  assert.ok(lostDays >= 9, `expected the drift to accumulate, got ${lostDays} days`);
});

test("the worker anchors on scheduledFor, not the clamped dueDate", () => {
  assert.match(SRC, /const anchor = new Date\(plan\.scheduledFor\)/);
  assert.match(SRC, /scheduledFor: due,/);
  // The clamp must still exist — it is what makes the cycle selector valid at all.
  assert.match(SRC, /const selectorDate =/);
  assert.doesNotMatch(SRC, /const anchor = new Date\(plan\.dueDate\)/);
});
