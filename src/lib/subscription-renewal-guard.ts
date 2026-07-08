/**
 * Phase 2 of subscription-renewal-honors-configured-grandfathered-price-never-
 * bills-standard: the pre-charge overcharge guard.
 *
 * A pure predicate that answers a single question at the pre-charge junction of
 * the internal renewal path (before the pending-transaction insert / Braintree
 * sale): does the engine's computed charge for each product line stay AT OR
 * BELOW the sub's own configured line ceiling? A grandfathered customer's
 * configured ceiling is either their stored per-unit `price_cents` (post-
 * discount baked lock) or their `price_override_cents` (pre-discount base). An
 * item with NEITHER lock is uncapped — the caller opted into live catalog
 * derivation.
 *
 * If ANY product line's computed unit exceeds its configured ceiling, the
 * guard fails (`ok: false`, reason `overcharge_above_configured`) — the caller
 * MUST NOT submit that charge to the gateway. It's a fail-safe: with the Phase
 * 1 engine change price_cents/price_override_cents already flow through as the
 * authoritative unit; this guard is the belt & suspenders that catches a future
 * repricing regression before it charges a grandfathered customer.
 *
 * Pure — no I/O, no DB. Wired at the pre-charge point of
 * `src/lib/inngest/internal-subscription-renewals.ts`.
 */

export interface RenewalGuardItem {
  variant_id?: string | number;
  quantity?: number;
  price_cents?: number | null;
  price_override_cents?: number | null;
  is_gift?: boolean;
}

export interface RenewalGuardLine {
  variant_id: string;
  quantity: number;
  unit_cents: number;
  kind: "product" | "gift" | "protection";
}

export interface RenewalGuardOffendingLine {
  variant_id: string;
  quantity: number;
  computed_unit_cents: number;
  configured_ceiling_cents: number;
}

export interface RenewalGuardResult {
  ok: boolean;
  reason?: "overcharge_above_configured";
  computed_product_cents: number;
  configured_cap_cents: number;
  offending_lines: RenewalGuardOffendingLine[];
}

/**
 * Compare the engine's computed per-line unit cents against each item's
 * configured ceiling. Product-only — gifts (unit $0 by design) + shipping
 * protection (flag-billed, not a catalog line) never contribute a ceiling
 * or a computed amount here.
 *
 * @param items - The subscription's line items (subForPricing / same shape the
 *                pricing engine consumed). Items with no ceiling are uncapped.
 * @param computedLines - The pricing engine's `pricing.lines`.
 * @returns `ok: true` when every product line stays AT OR BELOW its ceiling
 *          (or the line has no ceiling). `ok: false` when any product line's
 *          computed unit exceeds its ceiling — the renewal MUST be held.
 */
export function checkRenewalOverchargeGuard(
  items: RenewalGuardItem[],
  computedLines: RenewalGuardLine[],
): RenewalGuardResult {
  const offending: RenewalGuardOffendingLine[] = [];
  let computedTotal = 0;
  let cappedTotal = 0;

  for (const line of computedLines) {
    if (line.kind !== "product") continue;
    const lineComputed = line.unit_cents * line.quantity;
    computedTotal += lineComputed;

    // Match by variant_id (the pricing engine emits String(i.variant_id || "")).
    const it = items.find((i) => String(i.variant_id ?? "") === String(line.variant_id));
    if (!it || it.is_gift) continue;

    const ceiling =
      it.price_cents != null && Number(it.price_cents) > 0
        ? Number(it.price_cents)
        : it.price_override_cents != null && Number(it.price_override_cents) > 0
        ? Number(it.price_override_cents)
        : null;
    if (ceiling == null) continue; // uncapped — live catalog by opt-in

    cappedTotal += ceiling * line.quantity;

    if (line.unit_cents > ceiling) {
      offending.push({
        variant_id: String(line.variant_id),
        quantity: line.quantity,
        computed_unit_cents: line.unit_cents,
        configured_ceiling_cents: ceiling,
      });
    }
  }

  return {
    ok: offending.length === 0,
    reason: offending.length ? "overcharge_above_configured" : undefined,
    computed_product_cents: computedTotal,
    configured_cap_cents: cappedTotal,
    offending_lines: offending,
  };
}
