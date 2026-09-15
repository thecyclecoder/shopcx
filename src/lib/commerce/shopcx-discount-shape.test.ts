/**
 * Pin the two Shopify input/selection shapes whose violation fails SILENTLY-ENOUGH to ship.
 *
 * Both were live on `35945087149` and neither is caught by tsc, by a type, or by a guard:
 *
 *  1. `entitledLines: {lines:{add:[…]}}` without `all` → "Entitled lines all may not be empty".
 *     The message blames the line list, which is populated, so it reads as a bad line id. Every
 *     structural discount write went through this shape, which meant NO ShopCX line mutation
 *     could commit — quantity, swap, add and price-pin all returned an error that looked like a
 *     data problem on the contract.
 *
 *  2. `discountRemoved { id }` — `discountRemoved` is the SubscriptionDiscount UNION, so a bare
 *     field selection is a schema error: "Selections can't be made directly on unions". The
 *     removal failed, the structural clear returned early, and the recompute never ran.
 *
 * These assert the SHAPES our client sends, not Shopify's behaviour — that is verified live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLIENT = readFileSync(join(__dirname, "shopify-subscription-client.ts"), "utf8");

test("entitledLines is normalized so `all` is always present", () => {
  // The normalizer is the single place every discount write passes through.
  assert.match(CLIENT, /function normalizeEntitledLines/);
  assert.match(CLIENT, /return \{ all: false, lines: e\.lines \}/);
  // …and subscriptionDraftDiscountAdd must actually USE it, not pass `input` straight through.
  const addMutation = CLIENT.slice(CLIENT.indexOf("export async function shopifyAddDraftDiscount"));
  assert.match(
    addMutation.slice(0, 800),
    /entitledLines: normalizeEntitledLines\(input\.entitledLines\)/,
    "shopifyAddDraftDiscount must normalize entitledLines — a raw `input` reintroduces the missing-`all` failure",
  );
});

test("no bare field selection on the discountRemoved union", () => {
  const removals = CLIENT.match(/subscriptionDraftDiscountRemove\(draftId:\$d, discountId:\$x\)\{[\s\S]{0,120}?\}/g) ?? [];
  assert.ok(removals.length >= 2, `expected both removal call sites, found ${removals.length}`);
  for (const r of removals) {
    assert.doesNotMatch(
      r,
      /discountRemoved\s*\{\s*id\s*\}/,
      "discountRemoved is a union — select __typename or an inline fragment, never a bare field",
    );
    assert.match(r, /discountRemoved\s*\{\s*__typename\s*\}/);
  }
});

test("a code discount can never be mistaken for one of ours", () => {
  // Structural identification is by TITLE on a MANUAL discount. `SubscriptionAppliedCodeDiscount`
  // exposes no `title` at all (probed: its fields are id/code/rejectionReason/usageCount/…), so a
  // customer's coupon cannot match a structural title and cannot be stripped by the recompute.
  assert.match(CLIENT, /STRUCTURAL_DISCOUNT_TITLES\.includes\(String\(a\?\.discount\?\.title \?\? ""\)\)/);
  assert.match(CLIENT, /if \(d\.type && d\.type !== "MANUAL"\) continue;/);
});
