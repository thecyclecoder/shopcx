/**
 * Loyalty-ceiling hard-refusal predicate — the June-never-escalates-a-make-whole rail
 * (spec: loyalty-remedy-hard-cap-15-no-cashout-makewhole-june-never-escalates Phase 3).
 *
 * Phase 1 caps a SINGLE redemption at the shared validation chokepoint. Phase 2 closes double-
 * dip + coupon-stacking at the executor. Phase 3 closes the DECISION layer: before the founder-
 * approval gate PARKS a remedy, `planNeedsLoyaltyRefusal` REFUSES any loyalty-typed plan whose
 * known value exceeds `LOYALTY_REMEDY_MAX_CENTS` — so June never routes a $150 loyalty make-
 * whole to the founder for a yes/no/ask decision. The Chele ticket (2ba3b665) is the scar this
 * rule exists for.
 *
 *   npx tsx --test src/lib/june-remedy-approval.loyalty-refusal.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  planNeedsLoyaltyRefusal,
  planNeedsFounderApproval,
  MONEY_ACTION_TYPES,
  LOYALTY_ACTION_TYPES,
  type PlannedActionForGate,
} from "./june-remedy-approval";
import { LOYALTY_REMEDY_MAX_CENTS } from "./loyalty";

// ── Sets: loyalty actions are money, and are enumerated for the refusal predicate ──

test("MONEY_ACTION_TYPES now includes the two loyalty action types (spec Phase 3 §wire-into-money-gate)", () => {
  assert.equal(MONEY_ACTION_TYPES.has("apply_loyalty_coupon"), true);
  assert.equal(MONEY_ACTION_TYPES.has("redeem_points"), true);
  // pre-existing money types are preserved
  assert.equal(MONEY_ACTION_TYPES.has("partial_refund"), true);
  assert.equal(MONEY_ACTION_TYPES.has("redeem_points_as_refund"), true);
});

test("LOYALTY_ACTION_TYPES enumerates all three loyalty-derived actions", () => {
  assert.equal(LOYALTY_ACTION_TYPES.has("apply_loyalty_coupon"), true);
  assert.equal(LOYALTY_ACTION_TYPES.has("redeem_points"), true);
  assert.equal(LOYALTY_ACTION_TYPES.has("redeem_points_as_refund"), true);
});

// ── The two spec assertions — the primary Phase-3 verification ──

test("$150 loyalty make-whole (the Chele-ticket vector) is REFUSED — never escalated", () => {
  const plan: PlannedActionForGate[] = [
    {
      actionType: "apply_loyalty_coupon",
      actionParams: { code: "LOYALTY-150-ABCXYZ", contract_id: "gid://…" },
    },
  ];
  const r = planNeedsLoyaltyRefusal(plan);
  assert.equal(r.refused, true, "over-cap loyalty benefit MUST be refused, not parked");
  assert.equal(r.actionType, "apply_loyalty_coupon");
  assert.equal(r.valueCents, 15000);
  assert.match(r.reason ?? "", /ceiling/i);
  assert.match(r.reason ?? "", /make-whole|cash-out|expiry-extension/);
});

test("$15 in-cap loyalty coupon is ALLOWED — the legitimate save path is preserved", () => {
  const plan: PlannedActionForGate[] = [
    {
      actionType: "apply_loyalty_coupon",
      actionParams: { code: "LOYALTY-15-INCAP", contract_id: "gid://…" },
    },
  ];
  const r = planNeedsLoyaltyRefusal(plan);
  assert.equal(r.refused, false);
  assert.equal(r.actionType, null);
  assert.equal(r.valueCents, null);
});

// ── Signals for value extraction — parses code, discount_value, and amount_cents ──

test("redeem_points_as_refund with an explicit over-cap amount_cents is refused (1550¢ > 1500¢)", () => {
  const plan: PlannedActionForGate[] = [
    { actionType: "redeem_points_as_refund", actionParams: { amount_cents: 1550, tier_index: 3 } },
  ];
  assert.equal(planNeedsLoyaltyRefusal(plan).refused, true);
});

test("redeem_points with an explicit discount_value > $15 (dollar-scaled) is refused", () => {
  const plan: PlannedActionForGate[] = [
    { actionType: "redeem_points", actionParams: { discount_value: 20, tier_index: 4 } },
  ];
  const r = planNeedsLoyaltyRefusal(plan);
  assert.equal(r.refused, true);
  assert.equal(r.valueCents, 2000);
});

test("apply_loyalty_coupon: decimal-dollar code LOYALTY-15.50-* is parsed (1550¢) and refused", () => {
  const plan: PlannedActionForGate[] = [
    { actionType: "apply_loyalty_coupon", actionParams: { code: "LOYALTY-15.50-DECIMAL" } },
  ];
  assert.equal(planNeedsLoyaltyRefusal(plan).refused, true);
});

test("apply_loyalty_coupon: exactly-$15 code is at-cap (not over) → not refused (1500¢ === 1500¢)", () => {
  const plan: PlannedActionForGate[] = [
    { actionType: "apply_loyalty_coupon", actionParams: { code: "LOYALTY-15-BOUNDARY" } },
  ];
  assert.equal(planNeedsLoyaltyRefusal(plan).refused, false);
});

test("apply_loyalty_coupon: unsized code (legacy `smile-*`, no dollar segment) → not refused (falls through to founder gate)", () => {
  const plan: PlannedActionForGate[] = [
    { actionType: "apply_loyalty_coupon", actionParams: { code: "smile-abc-xyz" } },
  ];
  assert.equal(planNeedsLoyaltyRefusal(plan).refused, false);
});

test("case-insensitive LOYALTY prefix — `loyalty-150-*` still parses to $150 and refuses", () => {
  const plan: PlannedActionForGate[] = [
    { actionType: "apply_loyalty_coupon", actionParams: { code: "loyalty-150-lower" } },
  ];
  assert.equal(planNeedsLoyaltyRefusal(plan).refused, true);
});

// ── Non-interference: non-loyalty money actions are not touched ──

test("A non-loyalty partial_refund $200 is NOT refused by the loyalty predicate (belongs to founder gate)", () => {
  const plan: PlannedActionForGate[] = [
    { actionType: "partial_refund", actionParams: { amount_cents: 20000 } },
  ];
  assert.equal(planNeedsLoyaltyRefusal(plan).refused, false);
});

test("Empty plan → not refused", () => {
  assert.equal(planNeedsLoyaltyRefusal([]).refused, false);
});

test("Mixed plan (in-cap loyalty $10 + partial_refund $30) → not refused; loyalty is under cap", () => {
  const plan: PlannedActionForGate[] = [
    { actionType: "apply_loyalty_coupon", actionParams: { code: "LOYALTY-10-INCAP" } },
    { actionType: "partial_refund", actionParams: { amount_cents: 3000 } },
  ];
  assert.equal(planNeedsLoyaltyRefusal(plan).refused, false);
});

// ── Interaction with the founder gate: an in-cap loyalty coupon is sized (not gated as unknown) ──

test("Founder gate now SIZES a $15 LOYALTY-* coupon — batch of $30 partial_refund + $15 LOYALTY = $45 total, under $50 threshold → not gated", () => {
  const plan: PlannedActionForGate[] = [
    { actionType: "partial_refund", actionParams: { amount_cents: 3000 } },
    { actionType: "apply_loyalty_coupon", actionParams: { code: "LOYALTY-15-BOUNDARY" } },
  ];
  const gate = planNeedsFounderApproval(plan, 5000);
  assert.equal(gate.gated, false);
  assert.equal(gate.amountCents, 4500);
  assert.equal(gate.moneyLines.length, 2);
});

test("Founder gate SUMS loyalty into the batch total — $40 partial_refund + $15 LOYALTY = $55 > $50 threshold → gated (parks for founder)", () => {
  const plan: PlannedActionForGate[] = [
    { actionType: "partial_refund", actionParams: { amount_cents: 4000 } },
    { actionType: "apply_loyalty_coupon", actionParams: { code: "LOYALTY-15-EDGE" } },
  ];
  const gate = planNeedsFounderApproval(plan, 5000);
  assert.equal(gate.gated, true);
  assert.equal(gate.amountCents, 5500);
});

test("Founder gate: a LEGACY unsized loyalty coupon still collapses SUM to null → gates (conservative)", () => {
  const plan: PlannedActionForGate[] = [
    { actionType: "partial_refund", actionParams: { amount_cents: 3000 } },
    { actionType: "apply_loyalty_coupon", actionParams: { code: "smile-legacy-xyz" } },
  ];
  const gate = planNeedsFounderApproval(plan, 5000);
  assert.equal(gate.gated, true);
  assert.equal(gate.amountCents, null);
});
