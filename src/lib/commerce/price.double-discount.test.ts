/**
 * Regression tests for the ShopCX/Appstle (non-internal) double-discount display bug.
 *
 * Run: npx tsx --test src/lib/commerce/price.double-discount.test.ts  (script: test:price-double-discount)
 *
 * On non-internal subs the stored `items[].price_cents` is ALREADY post-Subscribe-&-Save / volume /
 * automatic (shopcx-line-ops.ts writes `realized = base − structuralDiscountCents`). The old
 * display calculator summed those baked prices and then re-applied EVERY `applied_discounts` entry,
 * subtracting Subscribe & Save a second time — the reminder showed $29.28 while the real charge was
 * ~$45.17. The fix: only subtract discounts that are NOT baked into the line price, drop spent
 * cycle-limited coupons, and de-dupe duplicate entries. These tests pin the two spec ground truths
 * plus the duplicated-entry case.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { priceSubscription, isBakedIntoLinePrice } from "@/lib/commerce/price";

/** A non-internal (ShopCX-shape) sub: list $69.95 baked to $52.46 after a 25% Subscribe & Save,
 *  one unit, $4.95 shipping. `applied_discounts` carries the S&S entry (baked) that the old
 *  calculator re-applied. Callers vary only the coupon(s). */
function shopcxSub(appliedDiscounts: Array<Record<string, unknown>>) {
  return {
    id: "sub-dd",
    is_internal: false,
    comp: false,
    items: [{ title: "Daily Greens", quantity: 1, price_cents: 5246, variant_id: "v1" }],
    delivery_price_cents: 495,
    applied_discounts: appliedDiscounts,
    shipping_protection_added: false,
    shipping_protection_amount_cents: 0,
  } as Record<string, unknown>;
}

/** The baked Subscribe & Save entry — 25% off, already reflected in the $52.46 line price. It must
 *  NOT be subtracted again. Modeled as a shop-wide automatic (how Shopify copies S&S onto the
 *  contract). */
const BAKED_SNS = { id: "d-sns", title: "Subscribe & Save", type: "AUTOMATIC_DISCOUNT", valueType: "PERCENTAGE", value: 25 };

/** An ACTIVE one-cycle $15 loyalty coupon (remaining_cycles 1) — applies on top of the line price. */
const ACTIVE_LOYALTY_15 = {
  id: "d-loy", code: "LOYALTY-15-ABC", title: "LOYALTY-15-ABC",
  type: "fixed_amount", value: 1500, recurring_cycle_limit: 1, remaining_cycles: 1, source: "internal",
};

/** Ground-truth list price: $69.95. The stored line ($52.46) is already 25% Subscribe & Save off
 *  this, so `6995` must NEVER be the basis for the displayed total — the baked $52.46 is. */
const LIST_PRICE_CENTS = 6995;

test("ground truth 1: baked S&S is NOT re-applied; an active $15 loyalty coupon nets $42.41 pre-tax", async () => {
  // The $52.46 stored line IS the $69.95 list already reduced by the 25% Subscribe & Save — proof
  // the discount is baked into price_cents, so it must not be subtracted a second time.
  assert.equal(Math.round(LIST_PRICE_CENTS * 0.75), 5246, "stored line $52.46 is $69.95 less 25% S&S");

  const { pricing } = await priceSubscription("ws", shopcxSub([BAKED_SNS, ACTIVE_LOYALTY_15]));
  // $52.46 line − $15 loyalty + $4.95 shipping = $42.41. (The bug double-applied S&S → ~$29.29.)
  assert.equal(pricing.total_cents, 4241);
  assert.equal(pricing.subtotal_cents, 5246);
  assert.equal(pricing.discount_cents, 1500);
  assert.notEqual(pricing.total_cents, 2929, "must not re-apply the baked 25% Subscribe & Save");
  // And the list price is never the display basis — that would strike through, not charge, $69.95.
  assert.notEqual(pricing.subtotal_cents, LIST_PRICE_CENTS);
});

test("ground truth 2: a spent one-cycle coupon (already used last order) is NOT subtracted → $57.41 pre-tax", async () => {
  // Same sub, but LOYALTY-15-* is limited to one billing cycle and was already used on the prior
  // order (remaining_cycles 0). Shopify will not bill it again, so the display must not subtract it.
  const spent = { ...ACTIVE_LOYALTY_15, remaining_cycles: 0 };
  const { pricing } = await priceSubscription("ws", shopcxSub([BAKED_SNS, spent]));
  assert.equal(pricing.total_cents, 5741); // $52.46 + $4.95 shipping, no coupon
  assert.equal(pricing.discount_cents, 0);
});

test("duplicated applied_discounts entries are counted once", async () => {
  // The same coupon stored twice (same id/code) must reduce the total only once.
  const { pricing } = await priceSubscription("ws", shopcxSub([BAKED_SNS, ACTIVE_LOYALTY_15, { ...ACTIVE_LOYALTY_15 }]));
  assert.equal(pricing.discount_cents, 1500);
  assert.equal(pricing.total_cents, 4241);
});

test("isBakedIntoLinePrice: only structural rates are baked; coupons AND Buy-N automatics stay on-top", () => {
  assert.equal(isBakedIntoLinePrice({ title: "Subscribe & Save", type: "MANUAL" }), true);
  assert.equal(isBakedIntoLinePrice({ title: "Volume discount", type: "MANUAL" }), true);
  assert.equal(isBakedIntoLinePrice({ title: "25% Subscribe & Save" }), true); // migrated-shape title fallback
  // A "Buy N" automatic is an order-wide discount applied ON TOP of currentPrice (Melissa
  // freeship regression) — NOT baked, even though its type is AUTOMATIC_DISCOUNT.
  assert.equal(isBakedIntoLinePrice({ title: "Buy 2 Discount", type: "AUTOMATIC_DISCOUNT" }), false);
  assert.equal(isBakedIntoLinePrice(ACTIVE_LOYALTY_15), false);
  assert.equal(isBakedIntoLinePrice({ code: "SAVE10", title: "SAVE10", type: "fixed_amount", value: 1000 }), false);
});
