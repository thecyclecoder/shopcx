/**
 * Unit tests for the next-order journey builder's pure last-product-line guard
 * (spec: renewal-reminder-first-run-fixes Phase 2 · [[../../docs/brain/journeys/next-order.md]]).
 *
 * Built-in node:test — no runner dependency. Run:
 *   npx tsx --test src/lib/next-order-journey-builder.test.ts
 *
 * `isLastProductLine` is the SINGLE predicate both the builder (marks items non-removable), the
 * mini-site editor (hides Remove, steers to skip/cancel), and the edit route (rejects a last-item
 * remove as validationError 'last_item' before dispatch) share — so the journey can never let a
 * customer empty a subscription via Remove (the 2026-11-24 first-run bug). These pin that the single
 * product line on a one-item sub is NOT removable and that Shipping Protection never counts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isLastProductLine } from "@/lib/next-order-journey-builder";

test("a single-item sub yields no removable items (the only product line is the last one)", () => {
  const items = [{ title: "Super Greens", variant_id: "v1" }];
  // The builder marks removable = !isLastProductLine(items, variant_id).
  const removable = items.map(i => !isLastProductLine(items, i.variant_id));
  assert.deepEqual(removable, [false]); // nothing removable on a single-product sub
  // This is exactly the predicate the edit route gates on → validationError 'last_item'.
  assert.equal(isLastProductLine(items, "v1"), true);
});

test("Shipping Protection never counts as a product line — a sub with 1 product + protection is still single-product", () => {
  const items = [
    { title: "Super Greens", variant_id: "v1" },
    { title: "Shipping Protection", variant_id: "ship" },
  ];
  assert.equal(isLastProductLine(items, "v1"), true); // removing the only real product empties it
  assert.equal(isLastProductLine(items, "ship"), false); // removing protection is always fine
});

test("a multi-product sub keeps every product removable", () => {
  const items = [
    { title: "Super Greens", variant_id: "v1" },
    { title: "Super Reds", variant_id: "v2" },
  ];
  assert.equal(isLastProductLine(items, "v1"), false);
  assert.equal(isLastProductLine(items, "v2"), false);
  const removable = items.map(i => !isLastProductLine(items, i.variant_id));
  assert.deepEqual(removable, [true, true]);
});

test("unknown / missing variant on a single-product sub is still treated as last (route blocks conservatively)", () => {
  const items = [{ title: "Super Greens", variant_id: "v1" }];
  assert.equal(isLastProductLine(items, undefined), true); // no target → 'exactly one product line?'
  assert.equal(isLastProductLine(items, "not-on-sub"), false); // targeting a line not on the sub
});

test("accepts a sub-like object with items, not just a bare array", () => {
  assert.equal(isLastProductLine({ items: [{ title: "Super Greens", variant_id: "v1" }] }, "v1"), true);
  assert.equal(isLastProductLine({ items: [] }, "v1"), false);
  assert.equal(isLastProductLine(null, "v1"), false);
});
