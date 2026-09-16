/**
 * Pins the CX-surface derivation the post-order review-ask composer keys
 * personalization off. See [[./review-request-cx-surface]] for the module
 * docstring and the ticket-7e3ee827 failing case this exists to prevent.
 *
 * The named failing state (the WHOLE reason this derivation exists):
 *
 *   Joanne Carey — an ~8-month repeat Amazing Coffee subscriber across 3
 *   contracts (1 active Cocoa x3, 2 cancelled) — received a post-order
 *   review ask that said "You tried Amazing Coffee for the first time" and
 *   "you've been with us about 5 months". Both were fabricated: the detector
 *   read her prior AC purchases as absent (they sat on linked customer_ids +
 *   inside subscription contracts the detector never opened), and the sender
 *   fed tenure from `customer.created_at` (her account) instead of her
 *   earliest observed activity.
 *
 * Tests below assert the CORRECT state — that:
 *
 *   1. A repeat subscriber whose prior purchases sit on a LINKED customer_id
 *      resolves to `window='repeat'` (not first-time).
 *   2. A repeat customer whose only prior purchase sits inside a CANCELLED
 *      subscription's items JSONB still resolves to `window='repeat'`.
 *   3. Tenure is derived from EARLIEST activity across the merged surface,
 *      not from a per-account `created_at`.
 *   4. A first-time buyer with full-visibility history is safely labelled
 *      `window='first-time'`.
 *   5. A blind-history customer (some prior order line items totally
 *      unreadable) has `window=null` — the composer's neutral opening
 *      asserts nothing, per the withhold-when-unverifiable contract.
 *   6. The pre-send guard REJECTS a proposed `first-time` window over a
 *      surface that shows a prior purchase — that is the contradiction the
 *      sender's throw is there to catch if a future edit ever routes around
 *      the derivation.
 *
 * Run: npx tsx --test src/lib/review-request-cx-surface.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveCxSurfacePersonalization,
  personalizationContradictsSurface,
  type ProductIdentityFingerprint,
} from "./review-request-cx-surface";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function amazingCoffeeFingerprint(): ProductIdentityFingerprint {
  // Concrete-enough shape to prove the matcher hits under all three id
  // shapes without a DB. `variant_a` is the "Cocoa x3" variant on Joanne's
  // active internal sub; `sku_ac_cocoa` is what the shopify-shape line items
  // carry; `shopify_ac` is the top-level shopify product id.
  return {
    internalProductId: "product-amazing-coffee",
    shopifyProductId: "shopify-ac",
    variantUuids: new Set(["variant-cocoa", "variant-hazelnut"]),
    shopifyVariantIds: new Set(["shopify-cocoa-vid", "shopify-hazelnut-vid"]),
    skus: new Set(["SKU_AC_COCOA", "SKU_AC_HAZELNUT"]),
  };
}

test("repeat subscriber across linked ids + cancelled contracts → window=repeat, tenure from earliest activity (Joanne)", () => {
  // The failing case, verbatim: 8 months since first AC order + 3 sub
  // contracts (1 active, 2 cancelled). The composer must NOT be told
  // first-time; the surface's earliest activity (8mo) must anchor tenure,
  // not a 5-month account.
  const derived = deriveCxSurfacePersonalization({
    orders: [
      // The anchor order — the "this ask" trigger. Excluded from the prior
      // scan by anchorOrderId.
      {
        id: "order-anchor",
        created_at: new Date(NOW - 3 * DAY).toISOString(),
        line_items: [{ variant_id: "shopify-cocoa-vid", sku: "SKU_AC_COCOA" }],
      },
      // A prior order, ~2 months old, on ONE OF THE LINKED customer_ids —
      // note the customer_id doesn't matter to the pure helper (the sender
      // already scoped by linkedIds); what matters is the line_items match.
      {
        id: "order-earlier",
        created_at: new Date(NOW - 60 * DAY).toISOString(),
        line_items: [{ variant_id: "shopify-cocoa-vid", sku: "SKU_AC_COCOA" }],
      },
      // Her earliest AC order — the tenure anchor. 8 months ago.
      {
        id: "order-earliest",
        created_at: new Date(NOW - 240 * DAY).toISOString(),
        line_items: [{ variant_id: "shopify-cocoa-vid", sku: "SKU_AC_COCOA" }],
      },
    ],
    subscriptions: [
      // Active internal sub — Cocoa x3.
      {
        id: "sub-active",
        subscription_created_at: new Date(NOW - 200 * DAY).toISOString(),
        created_at: new Date(NOW - 200 * DAY).toISOString(),
        items: [{ product_id: "product-amazing-coffee", variant_id: "variant-cocoa", quantity: 3 }],
      },
      // Cancelled prior contract — still counts as repeat evidence.
      {
        id: "sub-cancelled",
        subscription_created_at: new Date(NOW - 240 * DAY).toISOString(),
        created_at: new Date(NOW - 240 * DAY).toISOString(),
        items: [{ product_id: "product-amazing-coffee", variant_id: "variant-hazelnut", quantity: 4 }],
      },
    ],
    product: amazingCoffeeFingerprint(),
    anchorOrderId: "order-anchor",
    now: NOW,
  });

  assert.equal(derived.window, "repeat", "8-month AC subscriber must not be told first-time");
  assert.equal(derived.surfaceShowsRepeat, true);
  assert.equal(derived.withheldReason, null);
  // Tenure comes from the earliest activity (~240 days), NOT from a fresher
  // account_created_at. The composer's `Math.round(t/30)` renders "8 months".
  assert.ok(
    derived.tenureDays !== null && derived.tenureDays >= 230,
    `expected tenureDays >= 230 (~8 months), got ${derived.tenureDays}`,
  );
  assert.equal(Math.round((derived.tenureDays ?? 0) / 30), 8);
});

test("prior purchase sits ONLY inside a cancelled subscription → still window=repeat", () => {
  // The subtlest branch of the bug. Detector reads only orders.line_items;
  // subscriptions.items were invisible. A customer whose only AC touchpoint
  // is a cancelled contract is still a repeat customer.
  const derived = deriveCxSurfacePersonalization({
    orders: [
      // Anchor is the only order for this product. No prior orders exist.
      {
        id: "order-anchor",
        created_at: new Date(NOW - 5 * DAY).toISOString(),
        line_items: [{ variant_id: "shopify-cocoa-vid", sku: "SKU_AC_COCOA" }],
      },
    ],
    subscriptions: [
      // A CANCELLED prior contract for the same product. The old detector
      // never looked at this table — this is the exact shape the fix has to
      // catch.
      {
        id: "sub-cancelled",
        subscription_created_at: new Date(NOW - 210 * DAY).toISOString(),
        created_at: new Date(NOW - 210 * DAY).toISOString(),
        items: [{ product_id: "product-amazing-coffee", quantity: 3 }],
      },
    ],
    product: amazingCoffeeFingerprint(),
    anchorOrderId: "order-anchor",
    now: NOW,
  });

  assert.equal(derived.window, "repeat");
  assert.equal(derived.surfaceShowsRepeat, true);
});

test("tenure anchors on EARLIEST activity across the merged surface, not the freshest signal", () => {
  const derived = deriveCxSurfacePersonalization({
    orders: [
      {
        id: "order-anchor",
        created_at: new Date(NOW - 5 * DAY).toISOString(),
        line_items: [{ variant_id: "shopify-cocoa-vid" }],
      },
    ],
    subscriptions: [
      // A newer sub — irrelevant for tenure.
      {
        id: "sub-new",
        subscription_created_at: new Date(NOW - 30 * DAY).toISOString(),
        created_at: new Date(NOW - 30 * DAY).toISOString(),
        items: [{ product_id: "product-amazing-coffee" }],
      },
      // The earliest activity — the tenure anchor.
      {
        id: "sub-old",
        subscription_created_at: new Date(NOW - 400 * DAY).toISOString(),
        created_at: new Date(NOW - 400 * DAY).toISOString(),
        items: [{ product_id: "product-amazing-coffee" }],
      },
    ],
    product: amazingCoffeeFingerprint(),
    anchorOrderId: "order-anchor",
    now: NOW,
  });

  assert.ok(
    derived.tenureDays !== null && derived.tenureDays >= 395,
    `expected tenureDays >= 395 (~13 months), got ${derived.tenureDays}`,
  );
});

test("genuine first-time buyer with fully-visible history → window=first-time", () => {
  const derived = deriveCxSurfacePersonalization({
    orders: [
      {
        id: "order-anchor",
        created_at: new Date(NOW - 2 * DAY).toISOString(),
        line_items: [{ variant_id: "shopify-cocoa-vid" }],
      },
      // A readable prior order for a DIFFERENT product — the CX surface is
      // visible; absence of evidence for AC is real.
      {
        id: "order-other",
        created_at: new Date(NOW - 60 * DAY).toISOString(),
        line_items: [{ variant_id: "shopify-tabs-vid", sku: "SKU_TABS" }],
      },
    ],
    subscriptions: [],
    product: amazingCoffeeFingerprint(),
    anchorOrderId: "order-anchor",
    now: NOW,
  });

  assert.equal(derived.window, "first-time");
  assert.equal(derived.surfaceShowsRepeat, false);
  assert.equal(derived.withheldReason, null);
});

test("blind history (some prior order line items entirely unreadable) → window=null (withhold, not first-time)", () => {
  const derived = deriveCxSurfacePersonalization({
    orders: [
      {
        id: "order-anchor",
        created_at: new Date(NOW - 2 * DAY).toISOString(),
        line_items: [{ variant_id: "shopify-cocoa-vid" }],
      },
      // A prior order with NO readable identifiers — the classic pre-July
      // 2026 shape. We cannot prove "she never bought this before".
      {
        id: "order-blind",
        created_at: new Date(NOW - 90 * DAY).toISOString(),
        line_items: [{ title: "Something" }, { title: "Anything" }],
      },
    ],
    subscriptions: [],
    product: amazingCoffeeFingerprint(),
    anchorOrderId: "order-anchor",
    now: NOW,
  });

  assert.equal(derived.window, null, "blind history must withhold the claim, not default to first-time");
  assert.equal(derived.withheldReason, "history_blind");
  assert.equal(derived.surfaceShowsRepeat, false);
});

test("brand-new customer (no prior orders, no subs) → window=first-time is safe", () => {
  const derived = deriveCxSurfacePersonalization({
    orders: [
      {
        id: "order-anchor",
        created_at: new Date(NOW - 1 * DAY).toISOString(),
        line_items: [{ variant_id: "shopify-cocoa-vid" }],
      },
    ],
    subscriptions: [],
    product: amazingCoffeeFingerprint(),
    anchorOrderId: "order-anchor",
    now: NOW,
  });

  assert.equal(derived.window, "first-time");
});

test("contradiction guard: proposed first-time over a surface that shows repeat → CONTRADICTS", () => {
  const claim = deriveCxSurfacePersonalization({
    orders: [
      { id: "anchor", created_at: new Date(NOW - 1 * DAY).toISOString(), line_items: [{ variant_id: "shopify-cocoa-vid" }] },
      { id: "prior", created_at: new Date(NOW - 60 * DAY).toISOString(), line_items: [{ variant_id: "shopify-cocoa-vid" }] },
    ],
    subscriptions: [],
    product: amazingCoffeeFingerprint(),
    anchorOrderId: "anchor",
    now: NOW,
  });
  assert.equal(
    personalizationContradictsSurface({ claim, proposedWindow: "first-time" }),
    true,
    "first-time claim over a repeat surface must be flagged as a contradiction",
  );
  assert.equal(
    personalizationContradictsSurface({ claim, proposedWindow: "repeat" }),
    false,
  );
  assert.equal(
    personalizationContradictsSurface({ claim, proposedWindow: null }),
    false,
  );
});
