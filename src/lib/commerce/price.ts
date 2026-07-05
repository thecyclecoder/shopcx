/**
 * commerce/price.ts — the ONE money resolver.
 *
 * Phase 1 declares the surface (types re-export + PriceInvariantError). Phase 2
 * of this spec relocates `priceSubscription` here from
 * `src/lib/portal/helpers/enrich-pricing.ts` and adds the invariant guard: if
 * the engine or Appstle-baked path yields an undefined `unit_cents` /
 * `base_cents`, throw `PriceInvariantError` with the sub id + line id in the
 * message — so no surface can ever render $NaN / $0 / undefined cents.
 *
 * Keep this file the single import point for pricing across the SDK.
 */

export type { Cents, PricedLine } from "./types";

/**
 * Thrown when a resolved line yields an undefined / non-numeric cent value.
 * Message must include the sub id + line id so the dashboard alert can pinpoint
 * the row without a repro.
 */
export class PriceInvariantError extends Error {
  constructor(
    message: string,
    public readonly subscriptionId: string,
    public readonly lineId: string,
  ) {
    super(message);
    this.name = "PriceInvariantError";
  }
}
