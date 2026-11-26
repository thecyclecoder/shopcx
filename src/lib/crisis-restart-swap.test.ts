import { test } from "node:test";
import assert from "node:assert/strict";
import { findCrisisLine, futureRestock, crisisNotice, crisisSwapNote, customerIsWaitingForRestock, type CrisisSwapPlan } from "./crisis-restart-swap";

const keys = { variantKeys: new Set(["42614433480877", "uuid-sl"]), sku: "SC-TABS-SL-2" };

test("matches a crisis line by Shopify id, UUID or SKU", () => {
  assert.ok(findCrisisLine([{ variant_id: "42614433480877" }], keys));
  assert.ok(findCrisisLine([{ variant_id: "uuid-sl" }], keys));
  assert.ok(findCrisisLine([{ variant_id: "other", sku: "sc-tabs-sl-2" }], keys));
  assert.equal(findCrisisLine([{ variant_id: "other", sku: "SC-TABS-MB" }], keys), undefined);
});

test("restock date: past dates are hidden, timestamps are read as their day", () => {
  const now = new Date("2026-11-22T17:00:00Z");
  assert.equal(futureRestock("2026-11-01", now), null);
  assert.equal(futureRestock("2027-01-15T06:00:00+00:00", now), "2027-01-15");
  assert.equal(futureRestock(null, now), null);
});

test("notice names the out-of-stock flavor, the swap and the restock date", () => {
  const plan: CrisisSwapPlan = {
    crisisId: "c", item: {}, action: "swap", fromLabel: "Superfood Tabs — Strawberry Lemonade",
    toVariantId: "1", toLabel: "Mixed Berry", expectedRestock: "2027-01-15",
  };
  assert.equal(crisisNotice([]), null);
  assert.equal(
    crisisNotice([plan]),
    "Heads up: Superfood Tabs — Strawberry Lemonade is out of stock right now, so we'll send Mixed Berry instead and switch you back as soon as it's restocked (expected January 15).",
  );
  assert.match(crisisNotice([{ ...plan, expectedRestock: null }])!, /restocked\.$/);
});

test("customerIsWaitingForRestock: hold flag, rejected tiers, tier3 pause/remove all count as waiting", () => {
  assert.equal(customerIsWaitingForRestock(null), false);
  assert.equal(customerIsWaitingForRestock({}), false);
  assert.equal(customerIsWaitingForRestock({ tier1_response: "accepted_swap" }), false);
  assert.equal(customerIsWaitingForRestock({ hold_for_restock: true }), true);
  assert.equal(customerIsWaitingForRestock({ tier1_response: "rejected" }), true);
  assert.equal(customerIsWaitingForRestock({ tier2_response: "rejected" }), true);
  assert.equal(customerIsWaitingForRestock({ tier3_response: "accepted_pause" }), true);
  assert.equal(customerIsWaitingForRestock({ tier3_response: "accepted_remove" }), true);
  assert.equal(customerIsWaitingForRestock({ tier3_response: "rejected" }), false);
});

test("hold notice tells the customer we hold the sub and won't charge them", () => {
  const hold: CrisisSwapPlan = {
    crisisId: "c", item: {}, action: "hold", fromLabel: "Cocoa Instant Coffee",
    toVariantId: "1", toLabel: "Hazelnut", expectedRestock: "2027-01-15",
  };
  assert.equal(
    crisisNotice([hold]),
    "Cocoa Instant Coffee is out of stock right now. As you asked, we'll hold your subscription and ship Cocoa Instant Coffee as soon as it's back (expected January 15). You won't be charged until then.",
  );
  // No substitute flavor is named in a hold.
  assert.doesNotMatch(crisisNotice([hold])!, /Hazelnut/);
  assert.match(crisisNotice([{ ...hold, expectedRestock: null }])!, /as soon as it's back\. You won't be charged until then\.$/);
});

test("hold internal note says held for restock, resumes on resolve", () => {
  const hold: CrisisSwapPlan = {
    crisisId: "c", item: {}, action: "hold", fromLabel: "Cocoa Instant Coffee",
    toVariantId: "1", toLabel: "Hazelnut", expectedRestock: null,
  };
  assert.equal(
    crisisSwapNote([{ ...hold, ok: true }]),
    "Held for restock (customer chose to wait): Cocoa Instant Coffee; resumes automatically when the crisis is resolved.",
  );
});
