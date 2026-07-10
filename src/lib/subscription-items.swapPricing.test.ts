/**
 * Unit tests for decideSwapNewLineBaseCents — the post-portal-swap subscriber-price decision.
 * Derived from ticket d19c2192: a swap to a DIFFERENT-priced product must still apply the subscriber
 * S&S discount to the new line (not leave it at flat MSRP).
 *
 * Run:
 *   npx tsx --test src/lib/subscription-items.swapPricing.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideSwapNewLineBaseCents } from "./subscription-items";

test("d19c2192: swap to a DIFFERENT-priced product → new variant MSRP as base (25% cycle → subscriber price)", () => {
  // Creatine Prime (charge was e.g. $59.96 = $79.95 std) → Amazing Creamer ($69.95 std).
  // Old branch returned null here (newStandard !== oldStandard) → the bug. Now returns 6995.
  const base = decideSwapNewLineBaseCents({
    oldItemPriceCents: 5996,
    oldStandardCents: 7995,
    newStandardCents: 6995,
  });
  assert.equal(base, 6995); // base $69.95 → charge $52.46 after the 25% S&S cycle
});

test("like-for-like grandfathered swap → preserves the grandfathered base", () => {
  // Old line charged $44.97 on an $79.95-standard product (grandfathered), swapping to the SAME
  // $79.95-standard product. Preserve the grandfathered charge: base = round(4497 / 0.75) = 5996.
  const base = decideSwapNewLineBaseCents({
    oldItemPriceCents: 4497,
    oldStandardCents: 7995,
    newStandardCents: 7995,
  });
  assert.equal(base, Math.round(4497 / 0.75)); // 5996
});

test("like-for-like NON-grandfathered swap (old at standard) → new MSRP base", () => {
  // Old line was already at the standard subscriber price (not grandfathered): new line = its MSRP.
  const base = decideSwapNewLineBaseCents({
    oldItemPriceCents: 5996, // = 7995 * 0.75, i.e. standard, not grandfathered
    oldStandardCents: 7995,
    newStandardCents: 7995,
  });
  assert.equal(base, 7995);
});

test("no catalog price for the new variant → null (leave Appstle's value)", () => {
  assert.equal(
    decideSwapNewLineBaseCents({ oldItemPriceCents: 5996, oldStandardCents: 7995, newStandardCents: null }),
    null,
  );
  assert.equal(
    decideSwapNewLineBaseCents({ oldItemPriceCents: 5996, oldStandardCents: 7995, newStandardCents: 0 }),
    null,
  );
});

test("missing old-line price → still prices the new line at its MSRP", () => {
  const base = decideSwapNewLineBaseCents({
    oldItemPriceCents: null,
    oldStandardCents: null,
    newStandardCents: 6995,
  });
  assert.equal(base, 6995);
});

test("custom snsPct is honored for the grandfathered reverse-engineer", () => {
  // 20% sns: old charge $60 on $100 std → effective base = 60/0.8 = 7500 < 10000 → grandfathered.
  const base = decideSwapNewLineBaseCents({
    oldItemPriceCents: 6000,
    oldStandardCents: 10000,
    newStandardCents: 10000,
    snsPct: 20,
  });
  assert.equal(base, 7500);
});
