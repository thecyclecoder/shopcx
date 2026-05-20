/**
 * Shipping rates — server-side pricing.
 *
 * Rates live in `shipping_rates`, keyed by (workspace_id, code,
 * applies_to). Pricing is `base_cents + per_item_cents * chargeable_units`
 * capped at `max_total_cents`. Freebies (unit_price_cents = 0) don't
 * count toward `chargeable_units` so we never upcharge shipping for a
 * promotional add-on.
 *
 * `applies_to` follows the cart: if any line is `mode='subscribe'` the
 * cart counts as subscription for shipping. Mixed carts fall under
 * subscription rates because the subscribing item dominates the
 * fulfillment cadence.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type ShippingAppliesTo = "subscription" | "onetime";

export interface ShippingRate {
  id: string;
  workspace_id: string;
  code: string;
  applies_to: ShippingAppliesTo;
  name: string;
  description: string | null;
  base_cents: number;
  per_item_cents: number;
  max_total_cents: number | null;
  transit_days_min: number | null;
  transit_days_max: number | null;
  enabled: boolean;
  is_default: boolean;
  sort_order: number;
}

export interface PricedRate extends ShippingRate {
  total_cents: number;
}

interface LineLike {
  quantity: number;
  unit_price_cents: number;
  mode?: "subscribe" | "onetime";
}

export function appliesToFor(lines: LineLike[]): ShippingAppliesTo {
  return lines.some((l) => l.mode === "subscribe") ? "subscription" : "onetime";
}

/** Chargeable units = sum of quantity across lines with non-zero unit price. */
export function chargeableUnits(lines: LineLike[]): number {
  return lines.reduce((s, l) => (l.unit_price_cents > 0 ? s + l.quantity : s), 0);
}

export function priceRate(rate: ShippingRate, units: number): number {
  const raw = rate.base_cents + rate.per_item_cents * units;
  if (rate.max_total_cents != null && raw > rate.max_total_cents) return rate.max_total_cents;
  return raw;
}

export async function listRatesForCart(
  workspaceId: string,
  lines: LineLike[],
): Promise<PricedRate[]> {
  const applies = appliesToFor(lines);
  const units = chargeableUnits(lines);
  const admin = createAdminClient();
  const { data } = await admin
    .from("shipping_rates")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("applies_to", applies)
    .eq("enabled", true)
    .order("sort_order", { ascending: true });
  const rates = (data || []) as ShippingRate[];
  return rates.map((r) => ({ ...r, total_cents: priceRate(r, units) }));
}

export async function getRateById(rateId: string): Promise<ShippingRate | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("shipping_rates").select("*").eq("id", rateId).maybeSingle();
  return (data as ShippingRate | null) || null;
}

/**
 * Resolve a customer's chosen rate and price it against the current
 * cart. Used by the checkout server route. Falls back to the default
 * rate when the requested code isn't valid for this cart shape (e.g.
 * client asked for 'expedited' but cart is subscription-only and
 * subscription_expedited is disabled).
 */
export async function resolveRateForCart(
  workspaceId: string,
  lines: LineLike[],
  requestedCode: string | null | undefined,
): Promise<{ rate: ShippingRate; total_cents: number } | null> {
  const available = await listRatesForCart(workspaceId, lines);
  if (available.length === 0) return null;
  const wantCode = requestedCode || "economy";
  const chosen =
    available.find((r) => r.code === wantCode) ||
    available.find((r) => r.is_default) ||
    available[0];
  return { rate: chosen, total_cents: chosen.total_cents };
}
