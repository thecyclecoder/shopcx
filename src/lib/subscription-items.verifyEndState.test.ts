/**
 * Unit tests for `checkContractSatisfiesExpectation` — the Phase 1 pure predicate
 * that decides verified/not-verified from a live-Appstle-contract snapshot.
 *
 * Derived from the 2026-07-30 crisis: contracts 27946909869 and 27871477933 got
 * `{success:true}` back from `callReplaceVariants` even though Appstle never
 * moved the flavour. The predicate lets each mutation gate its success return on
 * an end-state check against the live contract instead of the upstream HTTP
 * status alone. Spec:
 *   docs/brain/specs/a-subscription-mutation-must-verify-it-happened-not-trust-http-200.md
 *
 * Run:
 *   npx tsx --test src/lib/subscription-items.verifyEndState.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkContractSatisfiesExpectation } from "./subscription-items";

const line = (variantId: string, quantity = 1, basePrice?: string) => ({
  variantId: `gid://shopify/ProductVariant/${variantId}`,
  quantity,
  pricingPolicy: basePrice != null ? { basePrice: { amount: basePrice } } : null,
});

test("add — variant present at requested quantity → ok", () => {
  const verdict = checkContractSatisfiesExpectation(
    [line("12345", 1)],
    { kind: "add", variantId: "12345", quantity: 1 },
  );
  assert.equal(verdict.ok, true);
});

test("add — variant present at HIGHER quantity (existing line merged) → ok", () => {
  // Appstle merges an add of qty 1 into an existing line at qty 2 → qty 3. The predicate treats
  // requested quantity as a LOWER bound (variant is present with at least that much).
  const verdict = checkContractSatisfiesExpectation(
    [line("12345", 3)],
    { kind: "add", variantId: "12345", quantity: 1 },
  );
  assert.equal(verdict.ok, true);
});

test("add — variant ABSENT from contract → failure names expectation + actual", () => {
  const verdict = checkContractSatisfiesExpectation(
    [line("67890", 1), line("24680", 2)],
    { kind: "add", variantId: "12345", quantity: 1 },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /variant 12345 present/);
  assert.match(verdict.reason!, /67890/);
  assert.match(verdict.reason!, /24680/);
});

test("remove — variant absent → ok", () => {
  const verdict = checkContractSatisfiesExpectation(
    [line("67890", 1)],
    { kind: "remove", variantId: "12345" },
  );
  assert.equal(verdict.ok, true);
});

test("remove — variant STILL PRESENT → failure names variant + quantity", () => {
  const verdict = checkContractSatisfiesExpectation(
    [line("12345", 2)],
    { kind: "remove", variantId: "12345" },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /variant 12345 absent/);
  assert.match(verdict.reason!, /quantity 2/);
});

test("swap — new variant present AND old absent → ok", () => {
  const verdict = checkContractSatisfiesExpectation(
    [line("NEW-999", 1)],
    { kind: "swap", oldVariantId: "OLD-111", newVariantId: "NEW-999", quantity: 1 },
  );
  assert.equal(verdict.ok, true);
});

test("swap — new added but OLD STILL PRESENT (partial apply) → failure", () => {
  // The 2026-07-30 crisis shape: the swap fired, the new variant landed, but Appstle silently
  // left the old flavour on the contract too — a partial apply that reports success.
  const verdict = checkContractSatisfiesExpectation(
    [line("OLD-111", 1), line("NEW-999", 1)],
    { kind: "swap", oldVariantId: "OLD-111", newVariantId: "NEW-999", quantity: 1 },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /OLD-111 absent/);
});

test("swap — new variant ABSENT (2xx no-op) → failure", () => {
  // Contracts 27946909869 / 27871477933: swap returned success=true, new variant never arrived.
  const verdict = checkContractSatisfiesExpectation(
    [line("OLD-111", 1)],
    { kind: "swap", oldVariantId: "OLD-111", newVariantId: "NEW-999", quantity: 1 },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /new variant NEW-999 present/);
});

test("price — line's basePrice matches → ok (with 1¢ tolerance)", () => {
  // 4996¢ vs 4995¢ (float rounding drift across the boundary) is within tolerance.
  const verdict = checkContractSatisfiesExpectation(
    [line("12345", 1, "49.95")],
    { kind: "price", variantId: "12345", expectedBaseCents: 4996 },
  );
  assert.equal(verdict.ok, true);
});

test("price — line's basePrice does NOT match → failure names both prices", () => {
  const verdict = checkContractSatisfiesExpectation(
    [line("12345", 1, "69.95")],
    { kind: "price", variantId: "12345", expectedBaseCents: 4995 },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /4995/);
  assert.match(verdict.reason!, /6995/);
});

test("price — line missing pricingPolicy.basePrice → failure (unverifiable, not silently ok)", () => {
  const verdict = checkContractSatisfiesExpectation(
    [line("12345", 1)],
    { kind: "price", variantId: "12345", expectedBaseCents: 4995 },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /no pricingPolicy\.basePrice/);
});
