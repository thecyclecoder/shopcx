/**
 * Pure-matcher tests for the cancelled-sub reactivation fallback at the
 * assisted-purchase routing boundary.
 *
 * Spec: docs/brain/specs/assisted-subscription-purchase-resolves-variant-
 * when-routing-omits-params.md.
 *
 * Ground-truth case (ticket e5dedbf8 — Deborah Kacprowicz): the customer
 * asked to restart her cancelled Cocoa French Roast subscription (2 bags
 * every 2 months). The orchestrator routed to `assisted-subscription-
 * purchase` but its decision carried NO `create_subscription` action with a
 * `variant_id`. `matchCancelledSubForStatedProduct` should resolve the
 * target variant + cadence from her matching cancelled sub so the routing
 * boundary can proceed instead of escalating.
 *
 * Run: `npx tsx --test src/lib/playbook-executor.cancelled-sub-fallback.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  matchCancelledSubForStatedProduct,
  type CancelledSubProjection,
} from "./playbook-executor";

const VARIANT_COCOA = "550e8400-e29b-41d4-a716-446655440000";
const VARIANT_VANILLA = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const VARIANT_MIXED = "6ba7b811-9dad-11d1-80b4-00c04fd430c9";

const COCOA_FRENCH_ROAST_2MO: CancelledSubProjection = {
  subscription_id: "875ed88e-1111-1111-1111-111111111111",
  billing_interval: "month",
  billing_interval_count: 2,
  items: [
    {
      variant_id: VARIANT_COCOA,
      title: "Cocoa French Roast",
      variant_title: "2 bags",
      sku: "cfr-2b",
      quantity: 1,
    },
  ],
};

const VANILLA_FRENCH_ROAST_1MO: CancelledSubProjection = {
  subscription_id: "875ed88e-2222-2222-2222-222222222222",
  billing_interval: "month",
  billing_interval_count: 1,
  items: [
    {
      variant_id: VARIANT_VANILLA,
      title: "Vanilla French Roast",
      variant_title: "1 bag",
      sku: "vfr-1b",
      quantity: 1,
    },
  ],
};

const MIXED_BERRY_WEEKLY: CancelledSubProjection = {
  subscription_id: "875ed88e-3333-3333-3333-333333333333",
  billing_interval: "week",
  billing_interval_count: 2,
  items: [
    {
      variant_id: VARIANT_MIXED,
      title: "Mixed Berry",
      variant_title: null,
      sku: "mb",
      quantity: 3,
    },
  ],
};

// ── ground-truth ─────────────────────────────────────────────────────────

test("Deborah's message + her cancelled Cocoa French Roast sub → resolves target variant + cadence", () => {
  const out = matchCancelledSubForStatedProduct({
    customerMsg:
      "I'd like to restart my Cocoa French Roast subscription, 2 bags every 2 months.",
    cancelledSubs: [COCOA_FRENCH_ROAST_2MO],
  });
  assert.ok(out, "matcher must resolve when the stated product names the cancelled sub");
  assert.equal(out.subscription_id, "875ed88e-1111-1111-1111-111111111111");
  assert.equal(out.variantId, VARIANT_COCOA);
  assert.equal(out.interval, "month");
  assert.equal(out.intervalCount, 2);
});

test("matcher ignores punctuation / case — 'cocoa french-roast?' still matches", () => {
  const out = matchCancelledSubForStatedProduct({
    customerMsg: "please turn my COCOA French-Roast? back on",
    cancelledSubs: [COCOA_FRENCH_ROAST_2MO, VANILLA_FRENCH_ROAST_1MO],
  });
  assert.ok(out);
  assert.equal(out.variantId, VARIANT_COCOA);
});

// ── ambiguity guard — the routing boundary must NOT guess ───────────────

test("two cancelled subs whose titles both appear in the message → null (escalate rather than guess)", () => {
  const out = matchCancelledSubForStatedProduct({
    customerMsg: "I want my Cocoa French Roast and my Vanilla French Roast back",
    cancelledSubs: [COCOA_FRENCH_ROAST_2MO, VANILLA_FRENCH_ROAST_1MO],
  });
  assert.equal(out, null, "ambiguity must bail — Sol's Direction boundary disambiguates");
});

// ── no-match cases ───────────────────────────────────────────────────────

test("customer names a product they never subscribed to → null", () => {
  const out = matchCancelledSubForStatedProduct({
    customerMsg: "can you sign me up for the Espresso Blend",
    cancelledSubs: [COCOA_FRENCH_ROAST_2MO],
  });
  assert.equal(out, null);
});

test("empty customer message → null", () => {
  const out = matchCancelledSubForStatedProduct({
    customerMsg: "",
    cancelledSubs: [COCOA_FRENCH_ROAST_2MO],
  });
  assert.equal(out, null);
});

test("no cancelled subs on file → null (routing boundary keeps escalating)", () => {
  const out = matchCancelledSubForStatedProduct({
    customerMsg: "restart my Cocoa French Roast subscription",
    cancelledSubs: [],
  });
  assert.equal(out, null);
});

test("misspelling ('Cacao French Roast' for 'Cocoa') → null (no fuzzy match, deliberate)", () => {
  const out = matchCancelledSubForStatedProduct({
    customerMsg: "restart my Cacao French Roast subscription",
    cancelledSubs: [COCOA_FRENCH_ROAST_2MO],
  });
  assert.equal(out, null);
});

// ── cadence-missing guard — a sub with no billing_interval is not usable ─

test("matched sub with billing_interval=null → null (cadence required to build create_subscription params)", () => {
  const orphan: CancelledSubProjection = {
    ...COCOA_FRENCH_ROAST_2MO,
    billing_interval: null,
  };
  const out = matchCancelledSubForStatedProduct({
    customerMsg: "restart my Cocoa French Roast subscription",
    cancelledSubs: [orphan],
  });
  assert.equal(out, null);
});

test("matched sub with billing_interval_count=null → null", () => {
  const orphan: CancelledSubProjection = {
    ...COCOA_FRENCH_ROAST_2MO,
    billing_interval_count: null,
  };
  const out = matchCancelledSubForStatedProduct({
    customerMsg: "restart my Cocoa French Roast subscription",
    cancelledSubs: [orphan],
  });
  assert.equal(out, null);
});

// ── quantity floor ──────────────────────────────────────────────────────

test("matched item.quantity=0 floors to 1 (never dispatch a zero-quantity subscription)", () => {
  const zero: CancelledSubProjection = {
    ...MIXED_BERRY_WEEKLY,
    items: [{ ...MIXED_BERRY_WEEKLY.items[0], quantity: 0 }],
  };
  const out = matchCancelledSubForStatedProduct({
    customerMsg: "restart my Mixed Berry",
    cancelledSubs: [zero],
  });
  assert.ok(out);
  assert.equal(out.quantity, 1);
});

// ── variant_title fallback — title null but variant_title matches ───────

test("item.title=null falls back to variant_title for the substring match", () => {
  const variantOnly: CancelledSubProjection = {
    ...MIXED_BERRY_WEEKLY,
    items: [
      {
        ...MIXED_BERRY_WEEKLY.items[0],
        title: null,
        variant_title: "Mixed Berry Powder",
      },
    ],
  };
  const out = matchCancelledSubForStatedProduct({
    customerMsg: "please restart my Mixed Berry Powder sub",
    cancelledSubs: [variantOnly],
  });
  assert.ok(out);
  assert.equal(out.variantId, VARIANT_MIXED);
});
