import { test } from "node:test";
import assert from "node:assert/strict";
import { findCrisisLine, futureRestock, crisisNotice, type CrisisSwapPlan } from "./crisis-restart-swap";

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
    crisisId: "c", item: {}, fromLabel: "Superfood Tabs — Strawberry Lemonade",
    toVariantId: "1", toLabel: "Mixed Berry", expectedRestock: "2027-01-15",
  };
  assert.equal(crisisNotice([]), null);
  assert.equal(
    crisisNotice([plan]),
    "Heads up: Superfood Tabs — Strawberry Lemonade is out of stock right now, so we'll send Mixed Berry instead and switch you back as soon as it's restocked (expected January 15).",
  );
  assert.match(crisisNotice([{ ...plan, expectedRestock: null }])!, /restocked\.$/);
});
