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

/**
 * Distinct refusal class — a price-guard refusal is US deliberately declining to proceed
 * because the post-swap realized price exceeds the rules-derived expectation, NOT a vendor
 * failure. Both the Appstle rail (subSwapVariant) and the internal rail (internalSubSwapVariant)
 * emit this shape on refusal, so downstream response classifiers can tell it apart from a real
 * Appstle error (a 5xx, a decline body, a network timeout).
 *
 * Ticket e2a55cfb (Isabel Disciullo, 2026-08-05): her portal replacevariants failure on the
 * internal contract internal-8922b5701b2f45ea was mislabeled as an Appstle vendor error even
 * though Appstle was not involved at all — the internal rail's own guard refused it. That
 * mislabel is what this class exists to prevent.
 */
export interface PriceGuardRefusal {
  contractId: string;
  expectedRealizedCents: number;
  observedRealizedCents: number;
  quantity: number;
  /** Machine-readable reason so the client can route the message. */
  reason: "swap_raises_over_rules";
}

/**
 * Build a customer-facing message for a price-guard refusal. Explains that the change WOULD
 * raise the per-unit price and (when quantity dropped) attributes it to a volume discount no
 * longer applying — so support and the customer both see a decision rather than a fault.
 * Kept pure so consumers can render it uniformly (portal 422 body, action-executor reason,
 * journey-complete telemetry) without duplicating copy.
 */
export function describePriceGuardRefusal(r: PriceGuardRefusal): string {
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  const base = `This change would raise the per-unit price from ${dollars(r.expectedRealizedCents)} (what our pricing rules produce for this line at quantity ${r.quantity}) to ${dollars(r.observedRealizedCents)}, so we've stopped it.`;
  const volumeHint = r.quantity <= 1
    ? " A volume discount that applied at a higher quantity may no longer apply at this quantity."
    : "";
  return `${base}${volumeHint} If this looks wrong, contact support with contract ${r.contractId}.`;
}
