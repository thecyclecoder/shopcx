/**
 * commerce/price.ts — the ONE money resolver.
 *
 * Owns `priceSubscription`, the shape-agnostic core that turns a subscription
 * row into per-line `{ base_cents, unit_cents }` + an order-level pricing summary
 * for every display surface (portal, mini-site, dashboard, ticket detail, AI
 * stack). Two branches, one shape:
 *   - **internal** — priced live by the engine ([[../pricing]])
 *   - **Appstle** — uses baked line prices, then normalizes the coupon on top
 *
 * Money invariant (Phase 2 of commerce-sdk-scaffold-money-resolver): every
 * priced line must yield a finite integer `base_cents` + `unit_cents`. If either
 * branch would yield undefined / NaN cents on a real product line, we throw
 * `PriceInvariantError` with the sub id + line id so the caller cannot silently
 * render $NaN / $0 / undefined. Gifts (unit $0) + shipping-protection lines are
 * expected zeros and are NOT gated.
 *
 * The legacy call sites still resolve via a thin shim at
 * `src/lib/portal/helpers/enrich-pricing.ts`, which re-exports this file's
 * `priceSubscription` while the migration to `@/lib/commerce` completes.
 */
import { resolveSubscriptionPricing, type DiscountPill } from "@/lib/pricing";
import { STRUCTURAL_DISCOUNT_TITLES } from "@/lib/commerce/shopify-subscription-client";

export type { Cents, PricedLine } from "./types";

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

export interface PricedLineLite {
  base_cents: number;
  unit_cents: number;
}

/**
 * Thrown when a subscription line's resolved money is not a finite integer —
 * i.e. `base_cents` or `unit_cents` would be `undefined` / `NaN`. This is the
 * "$NaN / $0 / undefined cents" leak the SDK exists to prevent. Message MUST
 * include the sub id + line id so a dashboard alert can pinpoint the row.
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

/** True iff `n` is a finite JS integer — the shape a cent count must have. */
function isValidCents(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function assertLineCents(subId: string, lineId: string, base: unknown, unit: unknown): void {
  if (!isValidCents(base) || !isValidCents(unit)) {
    throw new PriceInvariantError(
      `priceSubscription: line yielded undefined/NaN cents — sub=${subId} line=${lineId} base=${String(base)} unit=${String(unit)}`,
      subId,
      lineId,
    );
  }
}

/**
 * True iff a discount only affects the shipping line and must NOT reduce the
 * product subtotal. Shopify/Appstle models "free shipping" as a 100% PERCENTAGE
 * discount with `targetType: SHIPPING_LINE` — applying it against products
 * zeroes the subtotal and shows a fake "shipping only" total while the card is
 * billed the real product price (the Melissa-class portal bug). `targetType` is
 * the authoritative signal (captured at Appstle webhook ingest); the title
 * fallback covers rows synced before that field was persisted. All 417 live
 * shipping-target discounts are "Free Shipping…"/"…FreeShip" — no legitimate
 * 100%-off-product promo exists, so the fallback can't hide a real deal.
 */
function isShippingTargetDiscount(d: Record<string, unknown>): boolean {
  const target = String(d.targetType || d.target_type || "").toUpperCase();
  if (target === "SHIPPING_LINE") return true;
  if (target === "LINE_ITEM") return false; // explicit product target — never a shipping discount
  const title = String(d.title || d.code || "");
  return /free\s*ship/i.test(title);
}

/**
 * True iff a discount entry is ALREADY reflected in a non-internal sub's baked
 * `items[].price_cents` and must NOT be subtracted a second time off the display
 * subtotal. Re-applying a baked discount is the double-discount bug (the reminder
 * showed $29.28 while the real charge was ~$45.17).
 *
 * The authoritative baked set is the STRUCTURAL rates the engine already removed
 * from the line price — `shopcx-line-ops.ts` writes `realized = base −
 * structuralDiscountCents` over exactly `STRUCTURAL_DISCOUNT_TITLES` (Subscribe &
 * Save, Volume discount, the grandfathered Legacy rate), and Appstle's contract-line
 * `currentPrice` already reflects the same selling-plan Subscribe & Save. These show
 * up mirrored into `applied_discounts` and must be skipped.
 *
 * What is NOT baked — and still applies on top of the line price: order-level coupon
 * codes / loyalty / fixed-amount credits, AND contract-level automatics like Appstle's
 * "Buy N Discount" (an order-wide discount Shopify allocates over the lines, not folded
 * into `currentPrice`). The Melissa free-shipping regression (price.freeship.test.ts)
 * pins that an 8% "Buy 2 Discount" still applies — so the classifier is by title, not by
 * `type === AUTOMATIC_DISCOUNT`, which would wrongly swallow it. The title regex is only a
 * fallback for migrated rows whose Subscribe & Save carries its percent in the title
 * (e.g. "25% Subscribe & Save").
 */
export function isBakedIntoLinePrice(d: Record<string, unknown>): boolean {
  const title = String(d.title || "");
  if (STRUCTURAL_DISCOUNT_TITLES.includes(title)) return true;
  if (/subscribe\s*&?\s*save/i.test(title)) return true;
  return false;
}

/**
 * True iff a cycle-limited coupon is spent — Shopify will NOT bill it on the next
 * renewal, so the displayed total must not subtract it (the second ground-truth
 * case: a one-cycle LOYALTY-15-* already used on the prior order). `remaining_cycles`
 * is decremented per charge (null = forever); the Shopify-contract shape instead
 * carries `recurringCycleLimit` + `usageCount`. Exhausted ⇒ exclude.
 */
function isCouponExhausted(d: Record<string, unknown>): boolean {
  const remaining = d.remaining_cycles;
  if (remaining != null && Number(remaining) <= 0) return true;
  const limit = Number(d.recurringCycleLimit ?? d.recurring_cycle_limit ?? 0);
  const used = Number(d.usageCount ?? d.usage_count ?? 0);
  if (limit > 0 && used >= limit) return true;
  return false;
}

/** A single on-top coupon's face value in cents against a given subtotal (percentage ×
 *  subtotal, or a fixed amount capped at the subtotal). Mirrors the value logic in
 *  `computeDisplayCoupon`; used by the reminder cross-check to size a discount change. */
function couponFaceCents(d: Record<string, unknown>, subtotalCents: number): number {
  let pct = 0;
  let fixedCents = 0;
  if (d.type === "percentage") pct = Number(d.value) || 0;
  else if (d.type === "fixed_amount") fixedCents = Number(d.value) || 0;
  else if (d.valueType === "PERCENTAGE") pct = Number(d.value) || 0;
  else if (d.valueType === "FIXED_AMOUNT") fixedCents = Math.round((Number(d.value) || 0) * 100);
  const amt = pct > 0 ? Math.round(subtotalCents * (pct / 100)) : fixedCents;
  return Math.max(0, Math.min(amt, subtotalCents));
}

/**
 * Face value (cents) of on-top coupons that are SPENT / cycle-exhausted — billed on the PRIOR
 * renewal but NOT on the upcoming one. The reminder cross-check adds this back when comparing the
 * computed charge to the last paid order: a one-cycle coupon used last time legitimately makes
 * this renewal cost MORE, and that must not read as a mismatch. Baked + shipping-target entries
 * are never coupons, so they are skipped. Read-only.
 */
export function spentOnTopDiscountCents(
  appliedDiscounts: Array<Record<string, unknown>>,
  subtotalCents: number,
): number {
  let cents = 0;
  for (const d of dedupeDiscounts(appliedDiscounts || [])) {
    if (isBakedIntoLinePrice(d) || isShippingTargetDiscount(d)) continue;
    if (!isCouponExhausted(d)) continue;
    cents += couponFaceCents(d, subtotalCents);
  }
  return cents;
}

/** Stable identity for a discount entry so duplicated `applied_discounts` rows
 *  (same id/code/title) are counted once. */
function discountKey(d: Record<string, unknown>): string {
  return String(d.id ?? d.code ?? d.title ?? JSON.stringify(d));
}

/** De-duplicate discount entries by id/code/title, preserving first-seen order. */
function dedupeDiscounts(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const d of entries) {
    const k = discountKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

/** Normalize a coupon (either shape) → its display discount + pill. Read-only.
 *  `bakedLinePrices` (non-internal subs): the stored line prices already reflect
 *  subscription-level discounts, so skip the baked entries, drop spent coupons, and
 *  de-dupe — only genuine on-top coupons reduce the displayed total further. The
 *  internal branch passes it false and is unchanged. */
function computeDisplayCoupon(
  appliedDiscounts: Array<Record<string, unknown>>,
  subtotalCents: number,
  opts: { bakedLinePrices?: boolean } = {},
): { discountCents: number; pill: DiscountPill | null } {
  let remaining = subtotalCents;
  let discount = 0;
  let pillLabel: string | null = null;

  let entries = appliedDiscounts || [];
  if (opts.bakedLinePrices) {
    // Count each entry once, drop the ones already baked into the line price, and
    // drop spent cycle-limited coupons Shopify won't bill — matching the real charge.
    entries = dedupeDiscounts(entries).filter(
      (d) => !isBakedIntoLinePrice(d) && !isCouponExhausted(d),
    );
  }

  for (const d of entries) {
    // Shipping-target discounts (free shipping) don't touch the product
    // subtotal — skip them here so the displayed total matches the real charge.
    if (isShippingTargetDiscount(d)) continue;

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

type Line = { id?: string; variantId?: string; quantity?: number; currentPrice?: { amount?: string }; basePrice?: { amount?: string; currencyCode?: string } | null };

/**
 * Core: price a raw subscription row, shape-agnostic. Returns a map of per-line
 * `{ base_cents (strikethrough), unit_cents (charged) }` keyed by BOTH line_id and
 * variant_id, plus the order-level pricing summary. Internal subs price via the
 * engine; Appstle subs use their baked item prices. Consumed by every display
 * surface via `@/lib/commerce` (mini-site page render, portal handlers, dashboard
 * subscription widgets).
 *
 * Money invariant: throws `PriceInvariantError` if any product line resolves to
 * undefined/NaN cents. Gifts + shipping-protection are expected zeros and pass.
 */
/**
 * Shipping-protection cents for a sub's summary/renewal projection.
 *
 * A comp (free) sub charges nothing — its renewal bills $0 by design
 * (internal-subscription-renewals.ts). Protection must follow, or the portal
 * shows a $4.95 protection line + total the comp customer is never charged. So
 * comp ⇒ $0 protection; otherwise the added protection amount (0 when not added).
 * Pure so the invariant is unit-testable.
 */
export function resolveProtectionCents(sub: {
  comp?: boolean;
  shipping_protection_added?: boolean;
  shipping_protection_amount_cents?: number;
}): number {
  if (sub.comp) return 0;
  return sub.shipping_protection_added ? Number(sub.shipping_protection_amount_cents || 0) : 0;
}

/**
 * Shipping-Protection cents derived from a non-internal sub's contract LINE ITEMS.
 *
 * On many Appstle/ShopCX subs the protection fee is NOT the `shipping_protection_added` column — it's
 * a real contract line (`items[]` titled 'Shipping Protection', `price_cents` 500) with the column
 * still false. The column path (`resolveProtectionCents`) then returns 0 and the $5 fee silently
 * drops from the displayed total even though the renewal bills it (2026-11-28: sub 00d26522 showed
 * $52.46 but charged $57.46). This sums those lines (`price_cents * quantity`). The caller takes
 * `max(column, line)` so protection is counted EXACTLY once, never doubled. Pure.
 */
export function protectionLineCents(
  items: Array<{ price_cents?: number; quantity?: number; title?: string }>,
): number {
  let cents = 0;
  for (const it of items) {
    if (!String(it?.title || "").toLowerCase().includes("shipping protection")) continue;
    const unit = Number(it?.price_cents || 0);
    if (!Number.isFinite(unit) || unit <= 0) continue;
    cents += unit * (it?.quantity || 1);
  }
  return cents;
}

export async function priceSubscription(
  workspaceId: string,
  sub: Record<string, unknown>,
): Promise<{ priced: Map<string, PricedLineLite>; pricing: ContractPricing }> {
  const subId = String(sub.id ?? "unknown");
  let protectionCents = resolveProtectionCents({
    comp: !!sub.comp,
    shipping_protection_added: !!sub.shipping_protection_added,
    shipping_protection_amount_cents: Number(sub.shipping_protection_amount_cents || 0),
  });
  const priced = new Map<string, PricedLineLite>();
  let subtotalCents = 0;
  let msrpCents = 0;
  let shippingCents = Number(sub.delivery_price_cents || 0);
  const pills: DiscountPill[] = [];

  if (sub.is_internal) {
    const pricing = await resolveSubscriptionPricing(workspaceId, sub as { items?: unknown; delivery_price_cents?: number | null });
    for (const l of pricing.lines) {
      // Guard product lines only — engine returns kind='gift' with unit_cents=0
      // and kind='protection' with column-driven cents (both expected).
      if (l.kind === "product") {
        assertLineCents(subId, String(l.line_id ?? l.variant_id ?? "?"), l.base_cents, l.unit_cents);
      }
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
      const isProt = String(it.title || "").toLowerCase().includes("shipping protection");
      // Guard: a baked non-gift, non-protection line MUST carry a defined
      // price_cents. `Number(undefined || 0) = 0` used to leak silently.
      if (!it.is_gift && !isProt) {
        if (it.price_cents == null || !isValidCents(Number(it.price_cents))) {
          const lineId = String(it.line_id ?? it.variant_id ?? "?");
          throw new PriceInvariantError(
            `priceSubscription: Appstle-baked line missing price_cents — sub=${subId} line=${lineId} price_cents=${String(it.price_cents)}`,
            subId,
            lineId,
          );
        }
      }
      const unit = Number(it.price_cents || 0);
      const v = { base_cents: unit, unit_cents: unit };
      if (it.line_id) priced.set(String(it.line_id), v);
      if (it.variant_id != null) priced.set(String(it.variant_id), v);
      if (!it.is_gift && !isProt) subtotalCents += unit * (it.quantity || 1);
    }
    msrpCents = subtotalCents;
    // Shipping Protection billed as a real contract LINE (added-column false) must still land in the
    // TOTAL — it's out of the item subtotal above (not a product), but the renewal bills it. Take
    // max(column-derived, line-derived) so it's counted exactly once, never doubled.
    protectionCents = Math.max(protectionCents, protectionLineCents(items));
  }

  const { discountCents, pill } = computeDisplayCoupon(
    (sub.applied_discounts as Array<Record<string, unknown>>) || [],
    subtotalCents,
    // Non-internal subs carry BAKED line prices (already post-S&S / volume /
    // automatic); re-applying those entries is the double-discount bug. The
    // internal branch prices live and keeps its unchanged behavior.
    { bakedLinePrices: !sub.is_internal },
  );
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
