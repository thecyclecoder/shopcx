/**
 * Unit tests for the PURE applyVariantSkus() core of the Amplifier SKU
 * resolution. Built-in node:test — no runner dependency. Run:
 *   npx tsx --test src/lib/integrations/amplifier.test.ts
 *
 * Invariant (CEO 2026-07-23): product_variants is the SOURCE OF TRUTH for a
 * line's SKU at import time — NEVER the baked value on the order/subscription
 * line. Amplifier requires a SKU on every fulfillable line and drops SKU-less
 * lines; an internal subscription coffee line carried a variant_id but no baked
 * SKU → the line dropped → the order failed `no_skus` and never shipped. We
 * re-resolve every variant-identified line from the table (overriding baked
 * values) so a SKU change on the variant flows to all future orders, and a
 * missing baked SKU can't drop a real product.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyVariantSkus, type LineItem } from "./amplifier";

test("resolves a missing baked SKU from reference_id → variant SKU (the dropped-renewal case)", () => {
  const lines: LineItem[] = [
    { sku: null, title: "Amazing Coffee", reference_id: "9ef9311d", quantity: 1 },
  ];
  const map = new Map([["9ef9311d", "SC-INSTANTCO-COCOA"]]);
  const out = applyVariantSkus(lines, map);
  assert.equal(out[0].sku, "SC-INSTANTCO-COCOA");
});

test("OVERRIDES a stale baked SKU with the current variant SKU (variant table wins)", () => {
  // A SKU changed on the variant table — every future order must pick it up,
  // never the value baked onto the sub.
  const lines: LineItem[] = [
    { sku: "OLD-STALE-SKU", title: "Amazing Coffee", reference_id: "9ef9311d", quantity: 1 },
  ];
  const map = new Map([["9ef9311d", "SC-INSTANTCO-COCOA"]]);
  const out = applyVariantSkus(lines, map);
  assert.equal(out[0].sku, "SC-INSTANTCO-COCOA");
});

test("keeps the baked SKU when the reference_id has no variant row (fallback)", () => {
  const lines: LineItem[] = [
    { sku: "LEGACY-123", title: "Legacy line", reference_id: "no-such-variant", quantity: 1 },
  ];
  const map = new Map([["9ef9311d", "SC-INSTANTCO-COCOA"]]);
  const out = applyVariantSkus(lines, map);
  assert.equal(out[0].sku, "LEGACY-123");
});

test("leaves a SKU-less line with no matching variant untouched (digital good → dropped downstream)", () => {
  const lines: LineItem[] = [
    { sku: null, title: "30-Day Reset (digital)", reference_id: "1bc2111a", quantity: 1 },
  ];
  const map = new Map([["9ef9311d", "SC-INSTANTCO-COCOA"]]); // no entry for 1bc2111a
  const out = applyVariantSkus(lines, map);
  assert.equal(out[0].sku ?? null, null);
});

test("leaves a SKU-less line with NO reference_id untouched", () => {
  const lines: LineItem[] = [{ sku: null, title: "Shipping protection", quantity: 1 }];
  const map = new Map([["9ef9311d", "SC-INSTANTCO-COCOA"]]);
  const out = applyVariantSkus(lines, map);
  assert.equal(out[0].sku ?? null, null);
});

test("empty map is a no-op (returns input unchanged)", () => {
  const lines: LineItem[] = [{ sku: null, title: "Amazing Coffee", reference_id: "9ef9311d", quantity: 1 }];
  const out = applyVariantSkus(lines, new Map());
  assert.equal(out[0].sku ?? null, null);
});

test("mixed cart: overrides every variant-resolvable line, leaves the rest", () => {
  const lines: LineItem[] = [
    { sku: "ASC-MIX-1", title: "Free mixer", reference_id: "6b09d7d2", quantity: 1 },        // baked == variant
    { sku: null, title: "Amazing Coffee", reference_id: "9ef9311d", quantity: 1 },            // missing → resolved
    { sku: "OLD", title: "K-Cups", reference_id: "c1e1e38d", quantity: 1 },                   // stale → overridden
    { sku: null, title: "Digital reset", reference_id: "1bc2111a", quantity: 1 },             // no variant → stays null
  ];
  const map = new Map([
    ["6b09d7d2", "ASC-MIX-1"],
    ["9ef9311d", "SC-INSTANTCO-COCOA"],
    ["c1e1e38d", "SC-COFFEEPOD-NP24"],
  ]);
  const out = applyVariantSkus(lines, map);
  assert.equal(out[0].sku, "ASC-MIX-1");
  assert.equal(out[1].sku, "SC-INSTANTCO-COCOA");
  assert.equal(out[2].sku, "SC-COFFEEPOD-NP24");
  assert.equal(out[3].sku ?? null, null);
});
