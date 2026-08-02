/**
 * Pins `assertSwapDidNotRaise` — the pure never-raise predicate the swap SDK uses on both rails
 * to convert a silently-reset post-swap state into a caller-visible failure.
 *
 * SPEC: docs/brain/specs/swap-variant-preserves-the-line-price.md — Phase 3 verification.
 *
 * Run: npx tsx --test src/lib/swap-price-assertion.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertSwapDidNotRaise } from "./swap-price-assertion";

test("equal price passes (no raise)", () => {
  const err = assertSwapDidNotRaise({
    capturedRealizedCents: 3895,
    observedRealizedCents: 3895,
    contractId: "1234567890",
  });
  assert.equal(err, null);
});

test("lower post-swap price passes (a cheaper variant is always allowed)", () => {
  const err = assertSwapDidNotRaise({
    capturedRealizedCents: 3895,
    observedRealizedCents: 3200,
    contractId: "1234567890",
  });
  assert.equal(err, null);
});

test("higher post-swap price fails and names contract + expected + observed", () => {
  const err = assertSwapDidNotRaise({
    capturedRealizedCents: 3895,
    observedRealizedCents: 5246,
    contractId: "1234567890",
  });
  assert.ok(err, "expected a raise to be flagged");
  assert.ok(err.includes("1234567890"), `error must name the contract: ${err}`);
  assert.ok(err.includes("3895"), `error must name the expected price: ${err}`);
  assert.ok(err.includes("5246"), `error must name the observed price: ${err}`);
});

test("a 1-cent overshoot is inside the default 2-cent tolerance (arithmetic-solve rounding)", () => {
  const err = assertSwapDidNotRaise({
    capturedRealizedCents: 3895,
    observedRealizedCents: 3896,
    contractId: "1234567890",
  });
  assert.equal(err, null);
});

test("a 2-cent overshoot is inside the default 2-cent tolerance (boundary)", () => {
  const err = assertSwapDidNotRaise({
    capturedRealizedCents: 3895,
    observedRealizedCents: 3897,
    contractId: "1234567890",
  });
  assert.equal(err, null);
});

test("a 3-cent overshoot is outside the default 2-cent tolerance and fails", () => {
  const err = assertSwapDidNotRaise({
    capturedRealizedCents: 3895,
    observedRealizedCents: 3898,
    contractId: "1234567890",
  });
  assert.ok(err, "3-cent drift must exceed the 2-cent tolerance");
});

test("custom tolerance is respected", () => {
  const strict = assertSwapDidNotRaise({
    capturedRealizedCents: 3895,
    observedRealizedCents: 3896,
    contractId: "1234567890",
    toleranceCents: 0,
  });
  assert.ok(strict, "with 0-cent tolerance, any raise fails");
});
