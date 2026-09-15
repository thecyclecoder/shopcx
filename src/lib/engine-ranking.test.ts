/**
 * Pins the CEO engine preference order (2026-09-15):
 *
 *   internal (Braintree)  >  shopcx (our Shopify app)  >  appstle (vendor)
 *
 * The ranking is what decides which way a subscription may MOVE. Two things depend on it being
 * exactly this order, and both are silent if it drifts: vaulting a Braintree card promotes a
 * customer's appstle AND shopcx subs to internal, and the migration refuses anything that is not
 * a strict promotion (a sub going BACK to Appstle, which is being retired, is a bug by definition).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINE_RANK, isEnginePromotion } from "./internal-subscription";

test("internal beats shopcx beats appstle", () => {
  assert.ok(ENGINE_RANK.internal < ENGINE_RANK.shopcx, "internal must outrank shopcx");
  assert.ok(ENGINE_RANK.shopcx < ENGINE_RANK.appstle, "shopcx must outrank appstle");
});

test("every promotion the system performs is upward", () => {
  assert.equal(isEnginePromotion("appstle", "internal"), true);
  assert.equal(isEnginePromotion("shopcx", "internal"), true);
  assert.equal(isEnginePromotion("appstle", "shopcx"), true);
});

test("nothing may move DOWN the ranking", () => {
  assert.equal(isEnginePromotion("internal", "shopcx"), false);
  assert.equal(isEnginePromotion("internal", "appstle"), false);
  assert.equal(isEnginePromotion("shopcx", "appstle"), false);
});

test("an engine is never a promotion over itself", () => {
  for (const e of ["internal", "shopcx", "appstle"] as const) {
    assert.equal(isEnginePromotion(e, e), false, `${e} → ${e} is a no-op, not a migration`);
  }
});
