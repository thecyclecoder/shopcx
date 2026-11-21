/**
 * Regression test for [[../../docs/brain/specs/return-refund-includes-tax]] Phase 1 — a return's
 * refund INCLUDES the tax allocated to the returned product.
 *
 * NAMED FAILING STATE (founder rule 2026-11-19): tax was silently withheld on every return because
 * `computeReturnNetRefundCents` only saw the line subtotal. Live examples: SHOPCX516 $66.14 total
 * with $6.18 tax refunded only $59.96; SHOPCX560 $119.44 total with $9.10 tax refunded $110.34.
 * Laurie Predmore's Hazelnut return (ticket 7fe371ba) had to be topped up with tax as a SECOND
 * transaction — exactly what the founder does not want. The fix adds `taxCents` to the compute and a
 * pure `allocateReturnTaxCents` allocator; a refund must be ONE transaction that already covers tax.
 *
 * Pure — only exercises the two pure helpers; the async order-tax resolution + ledger read live at
 * the `createFullReturn` caller.
 *
 * Run:
 *   npm run test:shopify-returns-tax
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeReturnNetRefundCents, allocateReturnTaxCents } from "./shopify-returns";

test("computeReturnNetRefundCents — tax is ADDED to the refund: SHOPCX516 $59.96 subtotal + $6.18 tax, free label ⇒ $66.14 (NOT $59.96)", () => {
  const net = computeReturnNetRefundCents({
    orderSubtotalCents: 5996,
    taxCents: 618,
    labelCostCents: 0,
    refundsSucceededCents: 0,
  });
  assert.equal(net, 6614);
});

test("computeReturnNetRefundCents — omitting taxCents keeps the old tax-less behavior (backward compatible): $59.96 - $0 - $0 = $59.96", () => {
  const net = computeReturnNetRefundCents({
    orderSubtotalCents: 5996,
    labelCostCents: 0,
    refundsSucceededCents: 0,
  });
  assert.equal(net, 5996);
});

test("computeReturnNetRefundCents — a prior succeeded tax refund is netted so nobody is paid twice: Laurie SHOPCX732 total 22375, tax 1267 already refunded ⇒ 21108", () => {
  // Total 22375 = subtotal 21108 + tax 1267. The $12.67 tax was refunded separately on 2026-11-19,
  // so it sits in refundsSucceededCents and must net out: 21108 + 1267 - 1267 - 0 = 21108.
  const net = computeReturnNetRefundCents({
    orderSubtotalCents: 21108,
    taxCents: 1267,
    labelCostCents: 0,
    refundsSucceededCents: 1267,
  });
  assert.equal(net, 21108);
});

test("computeReturnNetRefundCents — tax plus a label both resolve: $110.00 subtotal + $9.10 tax - $8.50 label = $110.60", () => {
  const net = computeReturnNetRefundCents({
    orderSubtotalCents: 11000,
    taxCents: 910,
    labelCostCents: 850,
    refundsSucceededCents: 0,
  });
  assert.equal(net, 11060);
});

test("allocateReturnTaxCents — FULL return (returned subtotal == order subtotal) gets the WHOLE order tax", () => {
  const alloc = allocateReturnTaxCents({
    orderTaxCents: 618,
    orderSubtotalCents: 5996,
    returnedSubtotalCents: 5996,
  });
  assert.equal(alloc, 618);
});

test("allocateReturnTaxCents — PARTIAL return pro-rates tax by the returned lines' share of subtotal", () => {
  // Returning half the subtotal ⇒ half the tax (rounded).
  const alloc = allocateReturnTaxCents({
    orderTaxCents: 910,
    orderSubtotalCents: 12000,
    returnedSubtotalCents: 6000,
  });
  assert.equal(alloc, 455);
});

test("allocateReturnTaxCents — rounds to the nearest cent on an uneven split", () => {
  // 1267 * 7036 / 21108 = 422.33… ⇒ 422 cents.
  const alloc = allocateReturnTaxCents({
    orderTaxCents: 1267,
    orderSubtotalCents: 21108,
    returnedSubtotalCents: 7036,
  });
  assert.equal(alloc, 422);
});

test("allocateReturnTaxCents — never exceeds orderTaxCents even if the returned subtotal over-runs the order subtotal", () => {
  const alloc = allocateReturnTaxCents({
    orderTaxCents: 618,
    orderSubtotalCents: 5996,
    returnedSubtotalCents: 999999,
  });
  assert.equal(alloc, 618);
});

test("allocateReturnTaxCents — zero tax, zero subtotal, or zero returned-subtotal all yield 0 (no base to allocate against)", () => {
  assert.equal(allocateReturnTaxCents({ orderTaxCents: 0, orderSubtotalCents: 5996, returnedSubtotalCents: 5996 }), 0);
  assert.equal(allocateReturnTaxCents({ orderTaxCents: 618, orderSubtotalCents: 0, returnedSubtotalCents: 5996 }), 0);
  assert.equal(allocateReturnTaxCents({ orderTaxCents: 618, orderSubtotalCents: 5996, returnedSubtotalCents: 0 }), 0);
});

test("allocateReturnTaxCents — non-finite inputs are treated as 0 (defensive against a null tax column) — never a NaN refund", () => {
  const alloc = allocateReturnTaxCents({
    orderTaxCents: Number.NaN,
    orderSubtotalCents: 5996,
    returnedSubtotalCents: 5996,
  });
  assert.equal(alloc, 0);
});
