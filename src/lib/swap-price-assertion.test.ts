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

// ─── Anchor cases — real numbers from both incidents ─────────────────────────────────────────
// The two scenarios below LOOK identical to the naive "did the per-unit price go up" check —
// both end with a higher per-unit price after the swap — but only one is a bug. Without these
// pins the next person to touch the guard either re-breaks legitimate quantity changes or
// quietly weakens the protection that 286 reset subscriptions bought us.

test("MUST PASS — Isabel 2026-08-05: qty 2 → qty 1 legitimately reprices $48.27 → $52.46 (buy-two forfeited)", () => {
  // Ticket e2a55cfb (Isabel Disciullo, internal contract internal-8922b5701b2f45ea):
  // she was on 2 units at $48.27 (25% Subscribe & Save + 8% OFF Buy 2). The portal
  // sent replacevariants with quantity: 1, which correctly forfeits the buy-two break,
  // so the engine legitimately prices the line at $52.46 (25% S&S only) — a higher
  // per-unit rate, but exactly what the rules say. The guard MUST let this through.
  const err = assertSwapDidNotRaise({
    expectedRealizedCents: 5246, // priceSubscription: $69.95 × 0.75 S&S ≈ $52.46 at qty 1
    observedRealizedCents: 5246, // engine returned $52.46 on the post-swap line
    quantity: 1,
    contractId: "internal-8922b5701b2f45ea",
  });
  assert.equal(
    err,
    null,
    `a legitimate quantity-driven per-unit increase (buy-two forfeited) must pass, got: ${err}`,
  );
});

test("MUST FAIL — 2026-07-30 class: a grandfathered line reset to catalog ($69.95) when rules say $48.27", () => {
  // 2026-07-30 crisis: 286 subscriptions silently reset to catalog because
  // callReplaceVariants returned success on any 2xx without reading the body. A line
  // whose rules-derived rate is $48.27 (25% S&S + 8% buy-two on 2 units) coming back
  // at $69.95 catalog is NOT the rules' answer — it is a silent reset. The guard MUST
  // still fail loudly on this case; the Phase 1 rebaseline preserves the original
  // protection because catalog is far above the rules-derived expectation.
  const err = assertSwapDidNotRaise({
    expectedRealizedCents: 4827, // priceSubscription: $69.95 × 0.75 × 0.92 ≈ $48.27 at qty 2
    observedRealizedCents: 6995, // catalog $69.95 — S&S and buy-two both silently stripped
    quantity: 2,
    contractId: "27946909869", // an Appstle contract id from the 2026-07-30 batch
  });
  assert.ok(err, "a catalog reset from a rules-discounted line must fail loudly");
  assert.ok(err.includes("27946909869"), `error must name the contract: ${err}`);
  assert.ok(err.includes("4827"), `error must name the rules-derived expected price: ${err}`);
  assert.ok(err.includes("6995"), `error must name the observed catalog price: ${err}`);
});
