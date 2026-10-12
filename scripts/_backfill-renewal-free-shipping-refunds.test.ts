/**
 * Pins the per-order defect math for the renewal free-shipping refund backfill:
 * refund SHIPPING + the tax attributable to shipping ONLY, never product sales tax.
 *
 * Ground truth: ticket 00618fac order SC140231 — $4.95 shipping, true defect ~$5.42
 * (not the ~$10.17 June mistakenly refunded, which included legitimate product tax).
 *
 * Run: npx tsx --test scripts/_backfill-renewal-free-shipping-refunds.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { computeShippingDefectCents } from "./_backfill-renewal-free-shipping-refunds";

test("SC140231-shaped order: refund $4.95 shipping + ~$0.47 proportional tax = $5.42, not full tax", () => {
  // net product 116.01, shipping 4.95, no protection; effective ~9.49% tax on the
  // (116.01 + 4.95) = 120.96 base → $11.48 total tax. Shipping's share is ~$0.47.
  const { shipping, shippingTax, defect } = computeShippingDefectCents({
    subtotal_cents: 11601,
    discount_cents: 0,
    shipping_cents: 495,
    protection_cents: 0,
    tax_cents: 1148,
  });
  assert.equal(shipping, 495);
  assert.equal(shippingTax, 47); // round(1148 × 495 / 12096)
  assert.equal(defect, 542); // $5.42 — shipping + its proportional tax ONLY
});

test("no shipping charged → zero defect (never refund anything)", () => {
  assert.deepEqual(computeShippingDefectCents({ subtotal_cents: 11601, shipping_cents: 0, tax_cents: 1148 }), {
    shipping: 0,
    shippingTax: 0,
    defect: 0,
  });
});

test("zero tax on the order → defect is the bare shipping (no phantom tax)", () => {
  assert.deepEqual(computeShippingDefectCents({ subtotal_cents: 5000, shipping_cents: 495, tax_cents: 0 }), {
    shipping: 495,
    shippingTax: 0,
    defect: 495,
  });
});

test("protection is part of the taxable base and dilutes shipping's tax share", () => {
  const { shippingTax } = computeShippingDefectCents({
    subtotal_cents: 10000,
    discount_cents: 0,
    shipping_cents: 500,
    protection_cents: 495,
    tax_cents: 1000,
  });
  // base = 10000 + 500 + 495 = 10995; round(1000 × 500 / 10995) = round(45.5) = 45
  assert.equal(shippingTax, 45);
});
