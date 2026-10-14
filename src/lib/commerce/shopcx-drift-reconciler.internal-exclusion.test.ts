/**
 * Unit tests for the `isEscalatableLate` predicate — the single source of truth for
 * "should this late subscription PAGE anyone" in the subscription-drift monitor.
 *
 * Pins the boundary the spec introduced: an internal test account's lateness is counted (surfaced
 * in the heartbeat) but NEVER opens a `shopcx-subscription-health:late` repair job, mirroring how
 * dunning-held and inherited-from-Appstle lateness are already suppressed. A plain real-customer
 * late sub still escalates.
 *
 * No Supabase / no network — the predicate is pure.
 *
 * Run:
 *   tsx --test src/lib/commerce/shopcx-drift-reconciler.internal-exclusion.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isEscalatableLate, type LateSub } from "./shopcx-drift-reconciler";

function lateSub(overrides: Partial<LateSub> = {}): LateSub {
  return {
    contractId: "gid://shopify/SubscriptionContract/1",
    cadenceDays: 30,
    extraDays: 45,
    lastChargedAt: "2026-08-01T00:00:00.000Z",
    nextBillingDate: "2026-10-30T00:00:00.000Z",
    inDunning: false,
    inheritedFromAppstle: false,
    internalAccount: false,
    ...overrides,
  };
}

test("isEscalatableLate: a plain real-customer late sub escalates", () => {
  assert.equal(isEscalatableLate(lateSub()), true);
});

test("isEscalatableLate: an internal-account late sub is NOT escalatable", () => {
  assert.equal(isEscalatableLate(lateSub({ internalAccount: true })), false);
});

test("isEscalatableLate: dunning-held lateness is NOT escalatable (unchanged)", () => {
  assert.equal(isEscalatableLate(lateSub({ inDunning: true })), false);
});

test("isEscalatableLate: inherited-from-Appstle lateness is NOT escalatable (unchanged)", () => {
  assert.equal(isEscalatableLate(lateSub({ inheritedFromAppstle: true })), false);
});

test("isEscalatableLate: internal exclusion holds even when all other flags are clear", () => {
  // The only difference from the escalatable baseline is internalAccount — proves it is the
  // deciding factor, not an incidental pass through another suppressed category.
  const escalatable = lateSub();
  const internal = lateSub({ internalAccount: true });
  assert.equal(isEscalatableLate(escalatable), true);
  assert.equal(isEscalatableLate(internal), false);
});
