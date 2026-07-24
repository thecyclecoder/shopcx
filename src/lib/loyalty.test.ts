/**
 * Pin the manual-adjustment guard predicate for the loyalty
 * /api/loyalty/members/[memberId] POST route
 * (loyalty-list-stats-and-adjust-guard.md Phase 2). Before this predicate the
 * route did a raw `loyalty_transactions.insert` + `loyalty_members.update` with
 * only `Math.max(0, current + points)` clamping — silently masking under-flow
 * instead of rejecting an oversized deduction.
 *
 *   npx tsx --test src/lib/loyalty.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LOYALTY_REMEDY_MAX_CENTS,
  validateManualAdjustment,
  validateRedemption,
  type LoyaltyMember,
  type RedemptionTier,
} from "./loyalty";

const member = (points_balance: number): LoyaltyMember => ({
  id: "m1",
  workspace_id: "w1",
  customer_id: null,
  shopify_customer_id: null,
  email: null,
  points_balance,
  points_earned: 0,
  points_spent: 0,
  source: "test",
  created_at: "",
  updated_at: "",
});

const tier = (discount_value: number): RedemptionTier => ({
  label: `$${discount_value} Off`,
  points_cost: discount_value * 100,
  discount_value,
});

test("validateManualAdjustment rejects a zero delta", () => {
  const r = validateManualAdjustment(500, 0);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /required/i);
});

test("validateManualAdjustment rejects a non-finite delta", () => {
  const r = validateManualAdjustment(500, Number.NaN);
  assert.equal(r.ok, false);
});

test("validateManualAdjustment accepts a positive delta", () => {
  const r = validateManualAdjustment(500, 100);
  assert.equal(r.ok, true);
});

test("validateManualAdjustment accepts a negative delta that fits the balance", () => {
  const r = validateManualAdjustment(500, -500);
  assert.equal(r.ok, true);
});

test("validateManualAdjustment REJECTS a negative delta that exceeds the balance — never a negative balance", () => {
  const r = validateManualAdjustment(500, -501);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /below zero|insufficient|balance/i);
});

test("validateManualAdjustment rejects any deduction against a zero balance", () => {
  const r = validateManualAdjustment(0, -1);
  assert.equal(r.ok, false);
});

// ── LOYALTY_REMEDY_MAX_CENTS ceiling
// (loyalty-remedy-hard-cap-15-no-cashout-makewhole-june-never-escalates Phase 1) ──

test("LOYALTY_REMEDY_MAX_CENTS is the CEO's absolute $15 rail", () => {
  assert.equal(LOYALTY_REMEDY_MAX_CENTS, 1500);
});

test("validateRedemption ACCEPTS a $15 tier — the ceiling itself is in-cap", () => {
  const r = validateRedemption(member(1500), tier(15));
  assert.equal(r.valid, true);
});

test("validateRedemption REJECTS a $16 tier — one cent over the ceiling is out", () => {
  const r = validateRedemption(member(1600), tier(16));
  assert.equal(r.valid, false);
  if (!r.valid) assert.match(r.error ?? "", /ceiling|exceeds/i);
});

test("validateRedemption REJECTS a $150 make-whole tier (the Chele-ticket vector)", () => {
  const r = validateRedemption(member(15000), tier(150));
  assert.equal(r.valid, false);
});

test("validateRedemption still rejects an under-cap tier the member can't afford — insufficient-points path is untouched", () => {
  const r = validateRedemption(member(100), tier(10));
  assert.equal(r.valid, false);
  if (!r.valid) assert.match(r.error ?? "", /insufficient/i);
});
