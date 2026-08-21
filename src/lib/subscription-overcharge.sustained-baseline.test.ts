/**
 * Unit tests for the sustained-baseline predicate + variant-swap history
 * truncation — the two hardenings from ticket
 * b99f495e-7717-4553-a1bd-d095bb082094 (spec:
 * docs/brain/specs/overcharge-detector-baseline-must-be-a-sustained-rate-not-a-single-minimum).
 *
 * The pre-hardening detector used `Math.min(...history)` over every prior
 * renewal for a variant and never checked whether the variant had been
 * swapped away and back — so two disparate promo renewals ($26.96, $35.95)
 * were treated as a locked rate and the detector auto-proposed an improper
 * refund + a permanent below-floor price restore. The hardened predicate
 * (a) requires a sustained demonstrated rate (mode, or a rate held across
 * ≥N consecutive renewals) and (b) truncates the per-variant history at
 * the most recent swap-away boundary.
 *
 * Run:
 *   npx tsx --test src/lib/subscription-overcharge.sustained-baseline.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  postSwapVariantHistory,
  sustainedBaseline,
  SUSTAINED_BASELINE_MIN_SUPPORT,
} from "./subscription-overcharge";

// ── sustainedBaseline — the FAILING STATE the spec names ───────────────

test("returns null on Charlene's two disparate promo renewals (the ticket b99f495e failing case)", () => {
  // Two prior Mixed Berry renewals at $26.96 and $35.95 — one-off, below the
  // 50% floor, rising with quantity, i.e. expired introductory/promo pricing.
  // Pre-hardening Math.min would have returned 2696 (a false locked rate);
  // the sustained-rate predicate must return null so no signal fires.
  assert.equal(sustainedBaseline([3595, 2696]), null);
});

test("returns null when no rate meets the sustained-support threshold", () => {
  // Three renewals at three different rates — no rate is reliably paid.
  assert.equal(sustainedBaseline([5000, 4500, 4000]), null);
});

test("returns the rate held across N consecutive most-recent renewals", () => {
  // Four most-recent renewals at 4495 (any older 5000 is stale price creep).
  assert.equal(sustainedBaseline([4495, 4495, 4495, 4495, 5000]), 4495);
});

test("returns the mode when it meets the support threshold", () => {
  // 4495 appears 3× (mode), one recent 5100 dip does not break the sustained
  // rate — the mode is what the customer was reliably paying.
  assert.equal(sustainedBaseline([5100, 4495, 4495, 4495]), 4495);
});

test("mode path: tie-broken by the lowest rate (grandfathered at the cheaper one)", () => {
  // Alternating history so the head-run path fails and the mode path decides.
  // 4000 and 5000 each appear 3× — the customer's grandfathered rate is the
  // cheaper of the two.
  assert.equal(sustainedBaseline([5000, 4000, 5000, 4000, 5000, 4000]), 4000);
});

test("head-run path wins over the mode fallback (most-recent sustained rate)", () => {
  // Customer was on 4000 for 3 renewals long ago but the LAST 3 renewals have
  // been at 5000 — the current locked rate is 5000 (a price change stuck).
  assert.equal(sustainedBaseline([5000, 5000, 5000, 4000, 4000, 4000]), 5000);
});

test("respects a caller-supplied minSupport override", () => {
  // Two consecutive renewals at 4495 is enough at minSupport=2 but not at 3.
  assert.equal(sustainedBaseline([4495, 4495], 2), 4495);
  assert.equal(sustainedBaseline([4495, 4495], 3), null);
});

test("exports a minimum support constant of ≥ 3 (a single Math.min was the bug)", () => {
  // Guard: dropping the floor to ≤ 2 would let a two-renewal promo history
  // pass and reintroduce the ticket b99f495e failing state.
  assert.ok(
    SUSTAINED_BASELINE_MIN_SUPPORT >= 3,
    `SUSTAINED_BASELINE_MIN_SUPPORT must be ≥ 3, got ${SUSTAINED_BASELINE_MIN_SUPPORT}`,
  );
});

// ── postSwapVariantHistory — variant-swap lock reset ───────────────────

test("truncates history at the most recent swap-away boundary (variant absent)", () => {
  // Prior orders newest→oldest: A@60 (post-return), then B, B, then A@27,
  // A@36 (pre-swap). Walking from head, we hit the B order and STOP —
  // pre-swap prices $27/$36 are stale and must not feed the baseline.
  const prior = [
    { line_items: [{ variant_id: "A", price_cents: 6000 }] },
    { line_items: [{ variant_id: "B", price_cents: 5000 }] },
    { line_items: [{ variant_id: "B", price_cents: 5000 }] },
    { line_items: [{ variant_id: "A", price_cents: 2700 }] },
    { line_items: [{ variant_id: "A", price_cents: 3600 }] },
  ];
  assert.deepEqual(postSwapVariantHistory(prior, "A"), [6000]);
});

test("returns full history when the variant is present in every prior order", () => {
  const prior = [
    { line_items: [{ variant_id: "A", price_cents: 4495 }] },
    { line_items: [{ variant_id: "A", price_cents: 4495 }] },
    { line_items: [{ variant_id: "A", price_cents: 4495 }] },
  ];
  assert.deepEqual(postSwapVariantHistory(prior, "A"), [4495, 4495, 4495]);
});

test("coerces numeric variant ids to strings before comparison", () => {
  const prior = [{ line_items: [{ variant_id: 42, price_cents: 4495 }] }];
  assert.deepEqual(postSwapVariantHistory(prior, "42"), [4495]);
});

test("Charlene end-to-end: swap-away truncation + sustained-rate predicate both refuse", () => {
  // Ticket b99f495e reconstruction. Prior orders newest→oldest, with the
  // Mixed Berry → Peach Mango → Mixed Berry swap in the middle. After swap-
  // truncation only the two post-return Mixed Berry renewals remain, and at
  // two disparate rates no sustained baseline exists.
  const prior = [
    { line_items: [{ variant_id: "mixed_berry", price_cents: 3595 }] }, // SC124357
    { line_items: [{ variant_id: "mixed_berry", price_cents: 2696 }] }, // SC118679
    { line_items: [{ variant_id: "peach_mango", price_cents: 3595 }] }, // SC133146 — swap
    { line_items: [{ variant_id: "peach_mango", price_cents: 3595 }] }, // SC129376 — swap
  ];
  const history = postSwapVariantHistory(prior, "mixed_berry");
  assert.deepEqual(history, [3595, 2696]);
  assert.equal(sustainedBaseline(history), null);
});
