/**
 * Pure never-raise assertion for a variant-swap on either rail.
 *
 * The guard exists because `callReplaceVariants` returns success on any 2xx without reading the
 * body, and on 2026-07-30 286 subscriptions silently reset to catalog before anyone noticed. That
 * protection must survive.
 *
 * Semantics — compares the post-swap OBSERVED per-unit price against the EXPECTED per-unit price
 * the pricing rules produce for the new variant AT THE NEW QUANTITY. The old baseline (whatever
 * the line happened to cost before) was only meaningful while quantity stayed put — the moment a
 * customer changes how many units they take, the per-unit rate legitimately moves (dropping from
 * qty 2 to qty 1 forfeits the buy-two break, so the per-unit price correctly goes up). Comparing
 * against the rules keeps working when quantity changes: a catalog reset still lands far above the
 * rules-derived expectation and fails loudly, and a legitimate recomputation matches its
 * expectation and passes.
 *
 *   – `observed > expected + tolerance` → RAISE → return a human-readable error string.
 *   – anything at-or-below expected is fine (a cheaper realization than the rules is always allowed).
 *   – tolerance defaults to 2¢ so a legitimate Math.round drift on the arithmetic base-solve
 *     doesn't flip the assertion; anything bigger is a real regression to surface.
 *   – `null` means the invariant holds.
 *
 * Pure. Takes the expectation as an input (callers compute it via `resolveSubscriptionPricing`
 * on the post-swap items list) so the predicate stays free of DB access and directly unit-testable
 * (see swap-price-assertion.test.ts).
 */
export function assertSwapDidNotRaise(input: {
  expectedRealizedCents: number;
  observedRealizedCents: number;
  quantity: number;
  contractId: string;
  toleranceCents?: number;
}): string | null {
  const tolerance = input.toleranceCents ?? 2;
  const drift = input.observedRealizedCents - input.expectedRealizedCents;
  if (drift > tolerance) {
    return `Swap on contract ${input.contractId} raised the line price by ${drift}¢ — expected ≤ ${input.expectedRealizedCents}¢ for quantity ${input.quantity} (with ${tolerance}¢ tolerance), observed ${input.observedRealizedCents}¢`;
  }
  return null;
}
