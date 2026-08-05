/**
 * Pins `assertSwapDidNotRaise` — the pure never-raise predicate the swap SDK uses on both rails
 * to convert a silently-reset post-swap state into a caller-visible failure.
 *
 * Run: npx tsx --test src/lib/swap-price-assertion.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertSwapDidNotRaise } from "./swap-price-assertion";

test("observed equal to expected passes (no raise)", () => {
  const err = assertSwapDidNotRaise({
    expectedRealizedCents: 3895,
    observedRealizedCents: 3895,
    quantity: 1,
    contractId: "1234567890",
  });
  assert.equal(err, null);
});

test("observed below expected passes (grandfathered cheaper than rules is always allowed)", () => {
  const err = assertSwapDidNotRaise({
    expectedRealizedCents: 3895,
    observedRealizedCents: 3200,
    quantity: 1,
    contractId: "1234567890",
  });
  assert.equal(err, null);
});

test("observed above expected fails and names contract + expected + observed + quantity", () => {
  const err = assertSwapDidNotRaise({
    expectedRealizedCents: 3895,
    observedRealizedCents: 5246,
    quantity: 2,
    contractId: "1234567890",
  });
  assert.ok(err, "expected a raise to be flagged");
  assert.ok(err.includes("1234567890"), `error must name the contract: ${err}`);
  assert.ok(err.includes("3895"), `error must name the expected price: ${err}`);
  assert.ok(err.includes("5246"), `error must name the observed price: ${err}`);
  assert.ok(err.includes("quantity 2"), `error must name the quantity: ${err}`);
});

test("a 1-cent overshoot is inside the default 2-cent tolerance (arithmetic-solve rounding)", () => {
  const err = assertSwapDidNotRaise({
    expectedRealizedCents: 3895,
    observedRealizedCents: 3896,
    quantity: 1,
    contractId: "1234567890",
  });
  assert.equal(err, null);
});

test("a 2-cent overshoot is inside the default 2-cent tolerance (boundary)", () => {
  const err = assertSwapDidNotRaise({
    expectedRealizedCents: 3895,
    observedRealizedCents: 3897,
    quantity: 1,
    contractId: "1234567890",
  });
  assert.equal(err, null);
});

test("a 3-cent overshoot is outside the default 2-cent tolerance and fails", () => {
  const err = assertSwapDidNotRaise({
    expectedRealizedCents: 3895,
    observedRealizedCents: 3898,
    quantity: 1,
    contractId: "1234567890",
  });
  assert.ok(err, "3-cent drift must exceed the 2-cent tolerance");
});

test("custom tolerance is respected", () => {
  const strict = assertSwapDidNotRaise({
    expectedRealizedCents: 3895,
    observedRealizedCents: 3896,
    quantity: 1,
    contractId: "1234567890",
    toleranceCents: 0,
  });
  assert.ok(strict, "with 0-cent tolerance, any raise fails");
});
