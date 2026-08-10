/**
 * Unit tests for `identityExpectationForSwap` — the pure selector that decides
 * whether `subSwapVariant`'s identity verdict is verified as an `add` (self-swap,
 * i.e. the pure quantity change shape `change_quantity` uses) or as a `swap`
 * (genuine variant-to-variant move).
 *
 * Derived from a false-failure on Yvonne Carreon's contract (2026-08-05,
 * 2026-08-07): `change_quantity` calls subSwapVariant(_, _, v, v, qty) — old ===
 * new — and the `swap` verdict's `oldStill` branch fails whenever the old
 * variant is still present, which is ALWAYS true for a self-swap. The false
 * failure skips syncItemsAfterMutation AND the capturedUnitCents re-apply,
 * silently resetting the grandfathered price ($52.95 → $59.96 in Yvonne's case).
 *
 * The two-direction guarantee: a self-swap at a new quantity verifies OK; a
 * genuine swap that left the old variant behind still fails (the 2026-07-30
 * partial-apply defense must not weaken).
 *
 * Run:
 *   npx tsx --test src/lib/subscription-items.selfSwapIdentity.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkContractSatisfiesExpectation,
  identityExpectationForSwap,
} from "./subscription-items";

const line = (variantId: string, quantity = 1) => ({
  variantId: `gid://shopify/ProductVariant/${variantId}`,
  quantity,
  pricingPolicy: null,
});

test("identityExpectationForSwap — self-swap (old === new) picks `add` at the requested quantity", () => {
  const expected = identityExpectationForSwap("V-111", "V-111", 3);
  assert.deepEqual(expected, { kind: "add", variantId: "V-111", quantity: 3 });
});

test("identityExpectationForSwap — genuine swap (old ≠ new) picks strict `swap` (new present + old absent)", () => {
  const expected = identityExpectationForSwap("OLD-111", "NEW-999", 1);
  assert.deepEqual(expected, {
    kind: "swap",
    newVariantId: "NEW-999",
    oldVariantId: "OLD-111",
    quantity: 1,
  });
});

test("identityExpectationForSwap — string/number id mixing still detects a self-swap", () => {
  // Callers pass ids as either string or number-coerced-to-string; the selector must
  // still recognize the identity so change_quantity's self-swap doesn't misclassify.
  const expected = identityExpectationForSwap("42", "42", 2);
  assert.deepEqual(expected, { kind: "add", variantId: "42", quantity: 2 });
});

test("self-swap end-to-end — contract holds the variant at the new quantity → verdict ok", () => {
  // Real change_quantity success: the variant is still on the contract (of course
  // — it was a self-swap) at the NEW quantity. Under the old `swap` verdict this
  // would false-fail on `oldStill`. Under the new `add` verdict it verifies OK.
  const expected = identityExpectationForSwap("V-111", "V-111", 2);
  const verdict = checkContractSatisfiesExpectation([line("V-111", 2)], expected);
  assert.equal(verdict.ok, true);
});

test("self-swap end-to-end — contract holds the variant at a HIGHER quantity → verdict ok (>= requested)", () => {
  // `add` asserts quantity >= requested (Appstle sometimes merges lines). A
  // quantity change from 1 → 2 that ends up at qty 2 (or higher) is still success.
  const expected = identityExpectationForSwap("V-111", "V-111", 2);
  const verdict = checkContractSatisfiesExpectation([line("V-111", 3)], expected);
  assert.equal(verdict.ok, true);
});

test("self-swap end-to-end — contract holds the variant at a LOWER quantity → verdict fails", () => {
  // A genuine failure (Appstle didn't apply the increase) still fails — the
  // relaxation from `swap` to `add` doesn't turn a real miss into a fake pass.
  const expected = identityExpectationForSwap("V-111", "V-111", 3);
  const verdict = checkContractSatisfiesExpectation([line("V-111", 1)], expected);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /quantity 1/);
});

test("genuine swap end-to-end — old still on contract → verdict STILL fails", () => {
  // The 2026-07-30 crisis shape: a real variant-to-variant swap where Appstle
  // partially applied (both old and new landed). This branch is exactly what the
  // strict swap verdict is for; the self-swap change must not weaken it.
  const expected = identityExpectationForSwap("OLD-111", "NEW-999", 1);
  const verdict = checkContractSatisfiesExpectation(
    [line("OLD-111", 1), line("NEW-999", 1)],
    expected,
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /OLD-111 absent/);
});

test("genuine swap end-to-end — new absent (2xx no-op) → verdict STILL fails", () => {
  // The other 2026-07-30 shape: Appstle returned success but the new variant
  // never arrived. `swap` fails on new-not-present.
  const expected = identityExpectationForSwap("OLD-111", "NEW-999", 1);
  const verdict = checkContractSatisfiesExpectation([line("OLD-111", 1)], expected);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /new variant NEW-999 present/);
});
