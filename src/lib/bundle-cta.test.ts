/**
 * Phase 4 of offer-creator — bundle CTA target resolution.
 *
 * Pins the exact wiring the spec's Phase 4 verification names:
 *   "The Starter Kit variant renews at about $59.95 … its first order is
 *    $49.95 (the recurring_cycle_limit=1 coupon); the bundle PDP Select
 *    Bundle and the reasons-lander offer CTA both add THIS variant and its
 *    offer."
 *
 * The Select Bundle CTA reads `resolveBundleCtaTargets(data)` to decide
 * which variant to add and which coupon to auto-apply. This test locks in:
 *   - bundle_variant set → picks the Starter Kit variant (fires the offer at
 *     cart-add, since the offers.variant_id anchor matches).
 *   - bundle_variant absent → falls back to base_variant so an unwired
 *     workspace still gets a working CTA.
 *   - bundle_coupon_code rides on the CTA only when there's a variant to
 *     attach it to (a coupon without a matching variant is a no-op).
 *   - Neither variant present → both null (renders as scroll-to-#pricing).
 *
 * Run:
 *   npx tsx --test src/lib/bundle-cta.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveBundleCtaTargets } from "./bundle-cta";

const STARTER_KIT_VARIANT_ID = "11111111-1111-1111-1111-111111111111";
const BASE_VARIANT_ID = "22222222-2222-2222-2222-222222222222";
const COUPON_CODE = "STARTERKIT10";

test("Phase 4: prefers the Starter Kit variant when bundle_variant is set", () => {
  const result = resolveBundleCtaTargets({
    bundle_variant: { id: STARTER_KIT_VARIANT_ID },
    base_variant: { id: BASE_VARIANT_ID },
    bundle_coupon_code: COUPON_CODE,
  });
  assert.equal(result.variantId, STARTER_KIT_VARIANT_ID, "Starter Kit variant wins over base");
  assert.equal(result.couponCode, COUPON_CODE, "coupon rides along");
});

test("Phase 4: falls back to base_variant when bundle_variant is null (unwired workspace)", () => {
  const result = resolveBundleCtaTargets({
    bundle_variant: null,
    base_variant: { id: BASE_VARIANT_ID },
    bundle_coupon_code: null,
  });
  assert.equal(result.variantId, BASE_VARIANT_ID);
  assert.equal(result.couponCode, null);
});

test("Phase 4: coupon code is null when there's no variant to attach it to", () => {
  const result = resolveBundleCtaTargets({
    bundle_variant: null,
    base_variant: null,
    bundle_coupon_code: COUPON_CODE, // coupon set but no variant — no CTA to attach it to
  });
  assert.equal(result.variantId, null);
  assert.equal(result.couponCode, null, "coupon suppressed with no variant target");
});

test("Phase 4: no variants at all → both null (CTA falls back to scroll-to-pricing in the caller)", () => {
  const result = resolveBundleCtaTargets({});
  assert.equal(result.variantId, null);
  assert.equal(result.couponCode, null);
});

test("Phase 4: bundle_variant.id null but bundle_variant object present — treats as absent, falls back", () => {
  const result = resolveBundleCtaTargets({
    bundle_variant: { id: null },
    base_variant: { id: BASE_VARIANT_ID },
    bundle_coupon_code: COUPON_CODE,
  });
  assert.equal(result.variantId, BASE_VARIANT_ID);
  assert.equal(result.couponCode, COUPON_CODE, "coupon rides with base fallback too");
});
