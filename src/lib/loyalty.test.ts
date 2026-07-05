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

import { validateManualAdjustment } from "./loyalty";

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
