/**
 * Pure never-raise assertion for a variant-swap on either rail.
 *
 * SPEC: docs/brain/specs/swap-variant-preserves-the-line-price.md — Phase 3.
 *
 * `callReplaceVariants` returns success on any 2xx without reading the body, so "the swap
 * reported success" has repeatedly not meant the swap did what was intended (2026-07-30 crisis:
 * 286 subscriptions silently reset to catalog before anyone noticed). Phases 1 + 2 CARRY the
 * captured realized price forward on both rails; this is the assertion that turns a mispriced
 * post-swap state back into a caller-visible failure instead of a silent success.
 *
 * Semantics:
 *   – `observed > captured + tolerance` → RAISE → return a human-readable error string.
 *   – anything at-or-below captured is fine (a cheaper new variant is always allowed).
 *   – tolerance defaults to 2¢ so a legitimate Math.round drift on the arithmetic base-solve
 *     doesn't flip the assertion; anything bigger is a real regression to surface.
 *   – `null` means the invariant holds.
 *
 * Pure. Broken out of subscription-items.ts + internal-subscription.ts so we can unit-test the
 * predicate directly (see swap-price-assertion.test.ts) without standing up a subscription or an
 * Appstle vendor mock.
 */
export function assertSwapDidNotRaise(input: {
  capturedRealizedCents: number;
  observedRealizedCents: number;
  contractId: string;
  toleranceCents?: number;
}): string | null {
  const tolerance = input.toleranceCents ?? 2;
  const drift = input.observedRealizedCents - input.capturedRealizedCents;
  if (drift > tolerance) {
    return `Swap on contract ${input.contractId} raised the line price by ${drift}¢ — expected ≤ ${input.capturedRealizedCents}¢ (with ${tolerance}¢ tolerance), observed ${input.observedRealizedCents}¢`;
  }
  return null;
}
