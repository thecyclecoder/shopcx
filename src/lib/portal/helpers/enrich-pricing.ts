/**
 * Portal display pricing — one place that turns a subscription row into the
 * numbers the portal shows: per-line strikethrough + charged price, the
 * per-delivery total, and the qualified-discount pills.
 *
 * Internal subs are priced live by the engine ([[pricing]]). Appstle subs keep
 * their Appstle-baked line prices; we only layer the coupon on top so the total
 * reflects it. Coupons come in two shapes — the internal coupon engine's
 * `{ type, value }` and the Appstle-synced `{ valueType, value }` — and this
 * helper normalizes both (read-only; it never consumes a cycle).
 */
import { resolveSubscriptionPricing, type DiscountPill } from "@/lib/pricing";

export interface ContractPricing {
  /** Full MSRP subtotal (strikethrough) — Σ base × qty. */
  msrp_cents: number;
  /** Post S&S + quantity-break subtotal (pre-coupon). */
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  protection_cents: number;
  total_cents: number;
  free_shipping: boolean;
  pills: DiscountPill[];
}

type Line = { id?: string; variantId?: string; quantity?: number; currentPrice?: { amount?: string }; basePrice?: { amount?: string; currencyCode?: string } | null };

/** Normalize a coupon (either shape) → its display discount + pill. Read-only. */
function computeDisplayCoupon(
  appliedDiscounts: Array<Record<string, unknown>>,
  subtotalCents: number,
): { discountCents: number; pill: DiscountPill | null } {
  let remaining = subtotalCents;
  let discount = 0;
  let pillLabel: string | null = null;

  for (const d of appliedDiscounts || []) {
    let pct = 0;
    let fixedCents = 0;
    if (d.type === "percentage") pct = Number(d.value) || 0; // internal: 0-100
    else if (d.type === "fixed_amount") fixedCents = Number(d.value) || 0; // internal: cents
    else if (d.valueType === "PERCENTAGE") pct = Number(d.value) || 0; // appstle: 0-100
    else if (d.valueType === "FIXED_AMOUNT") fixedCents = Math.round((Number(d.value) || 0) * 100); // appstle: dollars
    else continue; // code-only legacy entry — can't compute a value

    let amt = pct > 0 ? Math.round(remaining * (pct / 100)) : Math.min(fixedCents, remaining);
    amt = Math.max(0, Math.min(amt, remaining));
    if (amt <= 0) continue;
    discount += amt;
    remaining -= amt;
    const code = (d.code as string) || (d.title as string) || "Coupon";
    pillLabel = pct > 0 ? `${pct}% OFF (${code})` : `$${(fixedCents / 100).toFixed(0)} OFF (${code})`;
  }

  return { discountCents: discount, pill: pillLabel ? { kind: "coupon", label: pillLabel } : null };
}

export interface PricedLineLite {
  base_cents: number;
  unit_cents: number;
}

/**
 * Core: price a raw subscription row, shape-agnostic. Returns a map of per-line
 * `{ base_cents (strikethrough), unit_cents (charged) }` keyed by BOTH line_id and
 * variant_id, plus the order-level pricing summary. Internal subs price via the
 * engine; Appstle subs use their baked item prices. Used by both the portal API
 * handlers (via enrichContractPricing) and the mini-site server render (page.tsx).
 */
export async function priceSubscription(
  workspaceId: string,
  sub: Record<string, unknown>,
): Promise<{ priced: Map<string, PricedLineLite>; pricing: ContractPricing }> {
  const protectionCents = sub.shipping_protection_added ? Number(sub.shipping_protection_amount_cents || 0) : 0;
  const priced = new Map<string, PricedLineLite>();
  let subtotalCents = 0;
  let msrpCents = 0;
  let shippingCents = Number(sub.delivery_price_cents || 0);
  const pills: DiscountPill[] = [];

  if (sub.is_internal) {
    const pricing = await resolveSubscriptionPricing(workspaceId, sub as { items?: unknown; delivery_price_cents?: number | null });
    for (const l of pricing.lines) {
      const v = { base_cents: l.base_cents, unit_cents: l.unit_cents };
      if (l.line_id) priced.set(String(l.line_id), v);
      priced.set(String(l.variant_id), v);
    }
    subtotalCents = pricing.product_subtotal_cents;
    msrpCents = pricing.product_msrp_cents;
    shippingCents = pricing.shipping_cents;
    pills.push(...pricing.discounts);
  } else {
    // Appstle — baked item prices; no strikethrough (MSRP = subtotal).
    const items = (Array.isArray(sub.items) ? sub.items : []) as Array<{ variant_id?: unknown; line_id?: string; price_cents?: number; quantity?: number; is_gift?: boolean; title?: string }>;
    for (const it of items) {
      const unit = Number(it.price_cents || 0);
      const v = { base_cents: unit, unit_cents: unit };
      if (it.line_id) priced.set(String(it.line_id), v);
      if (it.variant_id != null) priced.set(String(it.variant_id), v);
      const isProt = String(it.title || "").toLowerCase().includes("shipping protection");
      if (!it.is_gift && !isProt) subtotalCents += unit * (it.quantity || 1);
    }
    msrpCents = subtotalCents;
  }

  const { discountCents, pill } = computeDisplayCoupon((sub.applied_discounts as Array<Record<string, unknown>>) || [], subtotalCents);
  if (pill) pills.push(pill);

  const total = Math.max(0, subtotalCents - discountCents) + shippingCents + protectionCents;
  return {
    priced,
    pricing: {
      msrp_cents: msrpCents,
      subtotal_cents: subtotalCents,
      discount_cents: discountCents,
      shipping_cents: shippingCents,
      protection_cents: protectionCents,
      total_cents: total,
      free_shipping: shippingCents === 0,
      pills,
    },
  };
}

/**
 * Display helper for dashboard widgets (ticket page, customer page) that read raw
 * `subscriptions.items` and expect a baked `price_cents` per item. Internal subs
 * carry NO baked price (engine-derived), so their items show `$NaN` — this fills
 * each item's `price_cents` (engine charged unit) + `base_price_cents` (strike).
 * Appstle items already have a baked `price_cents`, so they pass through.
 */
export async function priceSubItemsForDisplay(
  workspaceId: string,
  sub: { id?: string; is_internal?: boolean | null; items?: unknown; delivery_price_cents?: number | null },
): Promise<Array<Record<string, unknown>>> {
  const items = (Array.isArray(sub.items) ? sub.items : []) as Array<Record<string, unknown>>;
  if (!sub.is_internal) return items;
  try {
    const { priced } = await priceSubscription(workspaceId, sub as Record<string, unknown>);
    return items.map((i) => {
      const p = priced.get(String(i.line_id || "")) || priced.get(String(i.variant_id ?? ""));
      if (!p) return i;
      return { ...i, price_cents: p.unit_cents, base_price_cents: p.base_cents > p.unit_cents ? p.base_cents : undefined };
    });
  } catch {
    return items;
  }
}

/** API-handler wrapper: prices the sub and writes base/charged onto contract.lines
 *  (internal subs only — Appstle lines already carry baked currentPrice). */
export async function enrichContractPricing(
  workspaceId: string,
  sub: Record<string, unknown>,
  contract: { lines?: unknown } & Record<string, unknown>,
): Promise<ContractPricing> {
  const { priced, pricing } = await priceSubscription(workspaceId, sub);
  if (sub.is_internal) {
    const lines = (Array.isArray(contract.lines) ? contract.lines : []) as Line[];
    contract.lines = lines.map((ln) => {
      const p = priced.get(String(ln.id || "")) || priced.get(String(ln.variantId || ""));
      if (!p) return ln;
      return {
        ...ln,
        currentPrice: { amount: (p.unit_cents / 100).toFixed(2), currencyCode: "USD" },
        basePrice: p.base_cents > p.unit_cents ? { amount: (p.base_cents / 100).toFixed(2), currencyCode: "USD" } : null,
      };
    });
  }
  return pricing;
}
