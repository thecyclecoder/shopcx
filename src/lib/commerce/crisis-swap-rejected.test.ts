/**
 * Phase 1 verification for
 * [[../../../docs/brain/specs/sol-crisis-swap-rejected-full-refund-and-sms-founder-to-cancel-amplifier-order]].
 *
 * Pins the three named-failing-state predicates the spec's Phase 1 §
 * Verification calls out:
 *
 *   1. A crisis-enrolled berry-only customer whose renewal created an order
 *      that will ship the default_swap flavor, and who rejects the substitute,
 *      is classified `crisis_swap_rejected` AND flagged for a FULL refund of
 *      the remaining balance (order_total − prior refunds).
 *   2. A customer who ACCEPTS the swap (or wants a different in-stock flavor)
 *      is NOT flagged for a full refund.
 *   3. A pure overcharge with an accepted flavor still resolves to a
 *      `overcharge_only` classification (the sibling price-correction partial
 *      path), NEVER a full refund.
 *
 * Run:
 *   npx tsx --test src/lib/commerce/crisis-swap-rejected.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCrisisSwap,
  detectSwapAcceptanceSignal,
  detectSwapRejectionSignal,
} from "./crisis-swap-rejected";

const ACTIVE_CRISIS = {
  id: "crisis-berry",
  status: "active",
  affected_variant_id: "variant-mixed-berry",
  default_swap_variant_id: "variant-tropical-swap",
} as const;

function makeOrder(overrides: Partial<{
  id: string;
  order_number: string | null;
  total_cents: number;
  prior_refunded_cents: number;
  line_items: Array<{ variant_id: string; title: string }>;
}> = {}) {
  return {
    id: "ord-1",
    order_number: "1001",
    total_cents: 11641,
    prior_refunded_cents: 0,
    line_items: [{ variant_id: "variant-tropical-swap", title: "Tropical (swap)" }],
    ...overrides,
  };
}

test("crisis-swap-rejected: renewal shipping the swap + rejection signal → FULL remaining-balance refund", () => {
  const r = classifyCrisisSwap({
    crisis: ACTIVE_CRISIS,
    order: makeOrder({ total_cents: 11641, prior_refunded_cents: 0 }),
    message: { text: "I only want mixed berry — no substitutions please. I'll wait." },
  });
  assert.equal(r.classification, "crisis_swap_rejected");
  assert.ok(r.refund_plan, "must produce a refund plan");
  assert.equal(r.refund_plan?.amount_cents, 11641, "full remaining balance");
  assert.equal(r.refund_plan?.order_id, "ord-1");
});

test("crisis-swap-rejected: prior partial is honored — refund amount = total − prior", () => {
  // The Cheri case cited in the spec: $116.41 total, $26.89 already refunded → $89.52 remainder.
  const r = classifyCrisisSwap({
    crisis: ACTIVE_CRISIS,
    order: makeOrder({ total_cents: 11641, prior_refunded_cents: 2689 }),
    message: { text: "Berry only — reject the swap please." },
  });
  assert.equal(r.classification, "crisis_swap_rejected");
  assert.equal(r.refund_plan?.amount_cents, 11641 - 2689);
});

test("swap accepted → NOT flagged for a full refund", () => {
  const r = classifyCrisisSwap({
    crisis: ACTIVE_CRISIS,
    order: makeOrder(),
    message: { text: "The swap is fine, thanks for letting me know." },
  });
  assert.equal(r.classification, "swap_accepted");
  assert.equal(r.refund_plan, undefined);
});

test("customer asks for a different in-stock flavor → NOT a full refund", () => {
  const r = classifyCrisisSwap({
    crisis: ACTIVE_CRISIS,
    order: makeOrder(),
    message: { text: "Can I get the greens flavor instead?" },
  });
  assert.equal(r.classification, "swap_accepted");
  assert.equal(r.refund_plan, undefined);
});

test("overcharge-only path: order does NOT carry the swap variant → overcharge_only, never a full refund", () => {
  const r = classifyCrisisSwap({
    crisis: ACTIVE_CRISIS,
    order: makeOrder({
      line_items: [{ variant_id: "variant-mixed-berry", title: "Mixed Berry" }],
    }),
    // Even a rejection-shaped message does not upgrade an order-without-swap to full-refund.
    message: { text: "I only want mixed berry, no substitutions." },
  });
  assert.equal(r.classification, "overcharge_only");
  assert.equal(r.refund_plan, undefined);
});

test("no active crisis → overcharge_only (defer to price-correction partial)", () => {
  const r = classifyCrisisSwap({
    crisis: { ...ACTIVE_CRISIS, status: "resolved" },
    order: makeOrder(),
    message: { text: "berry only, reject the swap" },
  });
  assert.equal(r.classification, "overcharge_only");
});

test("no rejection signal → no_match (silence is not rejection)", () => {
  const r = classifyCrisisSwap({
    crisis: ACTIVE_CRISIS,
    order: makeOrder(),
    message: { text: "When is my next order shipping?" },
  });
  assert.equal(r.classification, "no_match");
  assert.equal(r.refund_plan, undefined);
});

test("prior refund exceeds total → clamped to zero, never negative", () => {
  const r = classifyCrisisSwap({
    crisis: ACTIVE_CRISIS,
    order: makeOrder({ total_cents: 5000, prior_refunded_cents: 6000 }),
    message: { text: "berry only, I'll wait" },
  });
  assert.equal(r.classification, "crisis_swap_rejected");
  assert.equal(r.refund_plan?.amount_cents, 0);
});

test("detectSwapRejectionSignal: canonical rejection phrases", () => {
  assert.equal(detectSwapRejectionSignal("berry only"), true);
  assert.equal(detectSwapRejectionSignal("no substitutions please"), true);
  assert.equal(detectSwapRejectionSignal("I'll wait for mixed berry"), true);
  assert.equal(detectSwapRejectionSignal("I will wait until it's back in stock"), true);
  assert.equal(detectSwapRejectionSignal("I don't want the substitute"), true);
});

test("detectSwapRejectionSignal: acceptance overrides bare keyword", () => {
  // "berry only" appears, but customer's overall message ACCEPTS the swap.
  assert.equal(
    detectSwapRejectionSignal("berry only would've been my first pick but the swap is fine"),
    false,
  );
});

test("detectSwapAcceptanceSignal: canonical acceptance phrases", () => {
  assert.equal(detectSwapAcceptanceSignal("the swap is fine"), true);
  assert.equal(detectSwapAcceptanceSignal("happy to try the substitute"), true);
  assert.equal(detectSwapAcceptanceSignal("keep the swap"), true);
});
