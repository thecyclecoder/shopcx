/**
 * keepsGrandfatherAcrossSwap — a flavor swap keeps a grandfathered rate; a product swap drops it.
 * Ground truth: 54132179117 went $41.97 → $59.97 on a Peach Mango → Mixed Berry swap (2026-10-26).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { keepsGrandfatherAcrossSwap } from "./shopcx-line-ops";

const tabsPeach = { product_id: "7465708093613", price_cents: 7995 };
const tabsBerry = { product_id: "7465708093613", price_cents: 7995 };
const coffee = { product_id: "7467749965997", price_cents: 7995 };

test("same product, same MSRP (flavor swap) keeps the concession", () => {
  assert.equal(keepsGrandfatherAcrossSwap(tabsPeach, tabsBerry), true);
});
test("a different product drops it", () => {
  assert.equal(keepsGrandfatherAcrossSwap(tabsPeach, coffee), false);
});
test("same product at a different MSRP drops it (the concession was sized on the old price)", () => {
  assert.equal(keepsGrandfatherAcrossSwap(tabsPeach, { ...tabsBerry, price_cents: 8995 }), false);
});
test("an unknown outgoing or incoming variant drops it", () => {
  assert.equal(keepsGrandfatherAcrossSwap(undefined, tabsBerry), false);
  assert.equal(keepsGrandfatherAcrossSwap(tabsPeach, null), false);
});
