/**
 * Regression tests for commerce/price.priceSubscription coupon display —
 * specifically the shipping-target guard in `computeDisplayCoupon`.
 *
 * The Melissa-class portal bug (ticket eca3f43b): Shopify/Appstle models
 * "Free Shipping on Subscriptions" as a 100% PERCENTAGE discount with
 * `targetType: SHIPPING_LINE`. The resolver used to apply EVERY discount as a
 * percent off the product subtotal, so a free-shipping discount zeroed the
 * products → portal showed "Total $4.95 (shipping only)" while the card was
 * billed the full $116.96. This pins that a shipping-target discount never
 * reduces the product subtotal.
 *
 * The non-internal (Appstle) branch of priceSubscription is pure — it reads
 * baked `items[].price_cents` + `applied_discounts` with no DB — so these
 * cases run deterministically with no Supabase/Shopify.
 *
 * Run:
 *   npm run test:commerce-price-freeship
 *   (= tsx --test src/lib/commerce/price.freeship.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { priceSubscription } from "./price";

const WS = "11111111-1111-1111-1111-111111111111";

/** Appstle-shaped sub: 2× Superfood Tabs @ $59.96 = $119.92 subtotal, $4.95 shipping. */
function melissaSub(appliedDiscounts: Array<Record<string, unknown>>) {
  return {
    id: "sub-test",
    is_internal: false,
    delivery_price_cents: 495,
    applied_discounts: appliedDiscounts,
    items: [
      { line_id: "l1", variant_id: "v1", title: "Superfood Tabs", price_cents: 5996, quantity: 2 },
      { line_id: "l2", variant_id: "v2", title: "ACV Gummies", price_cents: 0, quantity: 1, is_gift: true },
    ],
  } as Record<string, unknown>;
}

test("free-shipping 100% discount (targetType SHIPPING_LINE) does NOT zero the product subtotal", async () => {
  const sub = melissaSub([
    { id: "d1", title: "Buy 2 Discount", type: "AUTOMATIC_DISCOUNT", value: 8, valueType: "PERCENTAGE", targetType: "LINE_ITEM" },
    { id: "d2", title: "Free Shipping on Subscriptions", type: "AUTOMATIC_DISCOUNT", value: 100, valueType: "PERCENTAGE", targetType: "SHIPPING_LINE" },
  ]);
  const { pricing } = await priceSubscription(WS, sub);
  assert.equal(pricing.subtotal_cents, 11992);
  // Only the real 8% line-item discount applies: round(11992 * 0.08) = 959.
  assert.equal(pricing.discount_cents, 959);
  assert.equal(pricing.shipping_cents, 495);
  assert.equal(pricing.total_cents, 11992 - 959 + 495); // 11528, NOT 495
  // The phantom "100% OFF" pill must be gone.
  assert.ok(!pricing.pills.some((p) => /100% OFF/.test(p.label)), "no 100%-off pill");
  assert.ok(pricing.pills.some((p) => p.label === "8% OFF (Buy 2 Discount)"));
});

test("title fallback: free-shipping discount with NO targetType (pre-backfill row) is still excluded", async () => {
  const sub = melissaSub([
    { id: "d2", title: "Free Shipping on Subscriptions", type: "AUTOMATIC_DISCOUNT", value: 100, valueType: "PERCENTAGE" },
  ]);
  const { pricing } = await priceSubscription(WS, sub);
  assert.equal(pricing.discount_cents, 0);
  assert.equal(pricing.total_cents, 11992 + 495);
});

test("VIPFreeShip variant title is also excluded", async () => {
  const sub = melissaSub([
    { id: "d3", title: "VIPFreeShip", type: "AUTOMATIC_DISCOUNT", value: 100, valueType: "PERCENTAGE" },
  ]);
  const { pricing } = await priceSubscription(WS, sub);
  assert.equal(pricing.discount_cents, 0);
});

test("legitimate line-item percentage discount still applies fully", async () => {
  const sub = melissaSub([
    { id: "d4", title: "Loyalty 10", type: "CODE_DISCOUNT", value: 10, valueType: "PERCENTAGE", targetType: "LINE_ITEM" },
  ]);
  const { pricing } = await priceSubscription(WS, sub);
  assert.equal(pricing.discount_cents, Math.round(11992 * 0.1)); // 1199
});

test("explicit LINE_ITEM target wins over a free-ship-ish title (never treated as shipping)", async () => {
  const sub = melissaSub([
    // Contrived: a real product discount that happens to mention 'ship'. The
    // authoritative targetType must keep it applied.
    { id: "d5", title: "Free Shipping Bundle Credit", value: 5, valueType: "FIXED_AMOUNT", targetType: "LINE_ITEM" },
  ]);
  const { pricing } = await priceSubscription(WS, sub);
  assert.equal(pricing.discount_cents, 500); // $5 off, applied
});
