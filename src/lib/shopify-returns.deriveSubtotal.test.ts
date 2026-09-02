/**
 * Regression test for [[../../docs/brain/specs/return-net-refund-must-net-per-line-discounts]]
 * Phase 1 — `deriveOrderSubtotalCentsFromLines` must net each line's `total_discount_cents`.
 *
 * The NAMED FAILING STATE from derived-from ticket `d17c7b1c` (Kimberly SC137380): a coffee line
 * $79.95 × 2 gross = $159.90 with a $12.78 line discount (customer paid $147.12) on an order that
 * collected $155.95. Before this fix the derivation summed the GROSS $159.90 and
 * `assertReturnRefundHeadroom` refused a legitimate Tier-2 return outright ("net_refund $159.90
 * exceeds live refundable ceiling $155.95"). The corrected derivation returns $147.12 — below the
 * live ceiling — so the return can be created.
 *
 * Pure — only exercises the derivation helper; the async ledger + headroom check are covered by
 * their own tests (`shopify-returns.netRefund.test.ts`).
 *
 * Run:
 *   npm run test:shopify-returns-derive-subtotal
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveOrderSubtotalCentsFromLines } from "./shopify-returns";

test("Kimberly SC137380 shape: coffee $79.95 × 2 − $12.78 discount ⇒ $147.12 (NOT $159.90)", () => {
  const subtotal = deriveOrderSubtotalCentsFromLines([
    { title: "Coffee", quantity: 2, price_cents: 7995, total_discount_cents: 1278 },
  ]);
  assert.equal(subtotal, 14712, "the subtotal must reflect what the customer actually paid ($147.12)");
  assert.notEqual(subtotal, 15990, "the pre-fix buggy value that tripped assertReturnRefundHeadroom");
});

test("discounted line still excludes Shipping Protection alongside", () => {
  const subtotal = deriveOrderSubtotalCentsFromLines([
    { title: "Coffee", quantity: 2, price_cents: 7995, total_discount_cents: 1278 },
    { title: "Shipping Protection", quantity: 1, price_cents: 600, total_discount_cents: 0 },
  ]);
  assert.equal(subtotal, 14712, "Shipping Protection must not fold into the refundable subtotal");
});

test("undiscounted line (total_discount_cents = 0) matches the pre-fix gross ⇒ backwards-compatible", () => {
  const subtotal = deriveOrderSubtotalCentsFromLines([
    { title: "Tabs", quantity: 2, price_cents: 5996, total_discount_cents: 0 },
  ]);
  assert.equal(subtotal, 11992, "an undiscounted line still sums to price × qty");
});

test("missing total_discount_cents field is treated as 0 (historical rows pre-webhook backfill)", () => {
  const subtotal = deriveOrderSubtotalCentsFromLines([
    { title: "Tabs", quantity: 2, price_cents: 5996 },
  ]);
  assert.equal(subtotal, 11992, "a missing discount field must never subtract");
});

test("mixed discounted + undiscounted lines each net their own discount", () => {
  const subtotal = deriveOrderSubtotalCentsFromLines([
    { title: "Coffee", quantity: 2, price_cents: 7995, total_discount_cents: 1278 }, // $147.12
    { title: "Tabs", quantity: 1, price_cents: 5996, total_discount_cents: 0 }, //     $59.96
  ]);
  assert.equal(subtotal, 14712 + 5996);
});

test("discount larger than gross floors at 0 for that line (never negative)", () => {
  const subtotal = deriveOrderSubtotalCentsFromLines([
    { title: "Free item", quantity: 1, price_cents: 1000, total_discount_cents: 5000 },
    { title: "Coffee", quantity: 1, price_cents: 7995, total_discount_cents: 0 },
  ]);
  assert.equal(subtotal, 7995, "a bad discount row cannot push the subtotal below the other lines");
});

test("non-finite total_discount_cents is treated as 0 (defensive against NaN from a null column)", () => {
  const subtotal = deriveOrderSubtotalCentsFromLines([
    { title: "Coffee", quantity: 2, price_cents: 7995, total_discount_cents: Number.NaN as unknown as number },
  ]);
  assert.equal(subtotal, 15990, "NaN discount must not corrupt the subtotal");
});

test("null / undefined / empty input → 0 (unchanged behaviour)", () => {
  assert.equal(deriveOrderSubtotalCentsFromLines(null), 0);
  assert.equal(deriveOrderSubtotalCentsFromLines(undefined), 0);
  assert.equal(deriveOrderSubtotalCentsFromLines([]), 0);
});
