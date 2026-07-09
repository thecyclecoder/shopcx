/**
 * Internal-subscription pricing engine — the single source of truth for what an
 * internal sub costs, used by BOTH the portal display and the renewal scheduler.
 *
 * Philosophy (Dylan, 2026-06): a subscription stores catalog *references*, not
 * baked prices — unless the sub carries a CONFIGURED / GRANDFATHERED lock. Two
 * lock shapes on `items[]` (both authoritative — a renewal never re-prices off
 * the current catalog when either is set, so a grandfathered customer is never
 * silently overcharged when a catalog price rises):
 *   1. `price_override_cents` — pre-discount grandfathered base. S&S + quantity
 *      break still apply on top (the engine reproduces the customer's rate).
 *   2. `price_cents` — baked per-unit charge. Used verbatim as the unit price;
 *      catalog rule decomposition is skipped entirely on that line (coupons on
 *      applied_discounts still apply through the caller).
 * When neither lock is present, the price is derived live from the catalog +
 * the product's pricing rule, so a catalog change flows through automatically.
 *
 * Rules, applied per line (multiplicative — see docs/brain/specs/storefront-mvp.md):
 *   base   = price_override_cents (grandfathered) ?? catalog product_variants.price_cents
 *   break% = quantity-break tier for the MIX-AND-MATCH total quantity of all lines
 *            sharing the line's pricing_rule (2 different flavors on the same rule
 *            → the qty-2 tier). Lines with no rule get no break.
 *   sns%   = pricing_rule.subscribe_discount_pct, else workspace.subscription_discount_pct
 *   unit   = round(base × (1 − break%/100) × (1 − sns%/100))
 * (Lock shape 2 above shortcuts this — `unit = price_cents` verbatim, no decomp.)
 *
 * Shipping protection + free gifts are NOT catalog-rule products: protection is a
 * passthrough add-on (its stored price, no discount) and is billed via the
 * sub's shipping_protection_* columns, so it's excluded from the discountable
 * product subtotal. Free gifts ($0) are a storefront concern, passthrough here.
 *
 * NOTE: this engine is INTERNAL-subs only. Appstle subs carry their pricing baked
 * by Appstle/Shopify — never run them through here.
 */
import { createAdminClient } from "@/lib/supabase/admin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PricingItem {
  variant_id?: string | number;
  product_id?: string;
  title?: string;
  variant_title?: string;
  sku?: string;
  quantity?: number;
  line_id?: string;
  is_gift?: boolean;
  /** Grandfathered locked base (pre-discount). Absent → use catalog price. */
  price_override_cents?: number | null;
  /** Configured/grandfathered baked unit price (post-discount). When set (and
   *  no `price_override_cents`), this is the AUTHORITATIVE renewal unit — the
   *  catalog + rule decomposition is skipped so a grandfathered customer is
   *  never silently overcharged when a catalog price rises. Historical Appstle
   *  migrations + some legacy internal-sub writes carry this. */
  price_cents?: number | null;
}

export type LineKind = "product" | "protection" | "gift";

export interface PricedLine {
  variant_id: string;
  product_id: string | null;
  title: string;
  variant_title: string;
  sku: string | null;
  quantity: number;
  line_id: string | null;
  is_gift: boolean;
  kind: LineKind;
  /** Strikethrough / "full" price per unit (override ?? catalog). */
  base_cents: number;
  /** Charged price per unit after quantity break + S&S. */
  unit_cents: number;
  break_pct: number;
  sns_pct: number;
  /** Did this unit price come from a grandfathered override? */
  is_grandfathered: boolean;
}

export interface DiscountPill {
  kind: "sns" | "quantity_break" | "free_shipping" | "coupon" | "renewal_offer";
  label: string;
}

/** An active, in-window persist-to-renewal offer overlaid on the base pricing rules.
 *  See pricing_rule_offers + docs/brain/specs/storefront-dynamic-renewal-offers.md. */
interface OfferRow {
  id: string;
  product_id: string | null;
  subscribe_discount_pct: number | null;
  renewal_price_cents: number | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
}

export interface SubscriptionPricing {
  lines: PricedLine[];
  /** Σ unit_cents × qty over *product* lines only — the discountable base. */
  product_subtotal_cents: number;
  /** Σ base_cents × qty over product lines — for "you save X" math. */
  product_msrp_cents: number;
  /** Resolved shipping for this renewal (0 when a rule grants free shipping). */
  shipping_cents: number;
  free_shipping: boolean;
  /** Qualified discounts as display pills (S&S, active quantity break, free
   *  shipping). Coupons are appended by the caller from applied_discounts. */
  discounts: DiscountPill[];
}

function isShippingProtection(i: PricingItem): boolean {
  return (i.title || "").toLowerCase().includes("shipping protection");
}

/** Mirror of the storefront's breakDiscountForQty (CustomizeClient.tsx). */
function breakPctForQty(
  breaks: Array<{ quantity: number; discount_pct: number }> | null | undefined,
  qty: number,
): number {
  if (!breaks?.length) return 0;
  const exact = breaks.find((b) => b.quantity === qty);
  if (exact) return exact.discount_pct || 0;
  const sorted = [...breaks].sort((a, b) => b.quantity - a.quantity);
  const fallback = sorted.find((b) => b.quantity <= qty);
  return fallback?.discount_pct || 0;
}

interface RuleRow {
  id: string;
  subscribe_discount_pct: number | null;
  quantity_breaks: Array<{ quantity: number; discount_pct: number }> | null;
  free_shipping: boolean | null;
  free_shipping_threshold_cents: number | null;
  free_shipping_subscription_only: boolean | null;
}

/**
 * Price every line of an internal subscription. `sub` must include `items` and
 * (for shipping) `delivery_price_cents`.
 */
export async function resolveSubscriptionPricing(
  workspaceId: string,
  sub: {
    items?: unknown;
    delivery_price_cents?: number | null;
    /** The persist-to-renewal offer this sub was acquired under (subscriptions.pricing_offer_id).
     *  Read at renewal: an `active`, in-window offer overrides the resolved S&S % (or pins a
     *  fixed renewal unit price) for its in-scope product lines. A reference, not a baked
     *  price — expiring/removing the offer reverts to base automatically. Absent on what-if
     *  quotes (no offer applied). See storefront-dynamic-renewal-offers.md (P1). */
    pricing_offer_id?: string | null;
  },
): Promise<SubscriptionPricing> {
  const admin = createAdminClient();
  const items = (Array.isArray(sub.items) ? sub.items : []) as PricingItem[];

  // 1. Catalog truth for every variant on the sub. Items store variant_id in
  //    EITHER shape — our internal product_variants UUID (some migrated subs) or
  //    the numeric Shopify variant id (others). Resolve both; the UUID column
  //    can't be compared against a numeric literal, so split by shape. Keying the
  //    map by BOTH id and shopify_variant_id lets `vmap.get(item.variant_id)`
  //    work regardless of which shape the item used.
  const rawIds = items.map((i) => String(i.variant_id || "")).filter(Boolean);
  const uuidIds = rawIds.filter((x) => UUID_RE.test(x));
  const numIds = rawIds.filter((x) => !UUID_RE.test(x));
  const orParts: string[] = [];
  if (uuidIds.length) orParts.push(`id.in.(${uuidIds.join(",")})`);
  if (numIds.length) orParts.push(`shopify_variant_id.in.(${numIds.map((s) => `"${s}"`).join(",")})`);
  const { data: variants } = orParts.length
    ? await admin.from("product_variants").select("id, shopify_variant_id, price_cents, product_id").or(orParts.join(","))
    : { data: [] as Array<{ id: string; shopify_variant_id: string; price_cents: number; product_id: string }> };
  const vmap = new Map<string, { id: string; shopify_variant_id: string; price_cents: number; product_id: string }>();
  for (const v of variants || []) {
    vmap.set(String(v.id), v);
    if (v.shopify_variant_id) vmap.set(String(v.shopify_variant_id), v);
  }

  // 2. Each product's pricing rule (via the product_pricing_rule join).
  const productIds = [...new Set((variants || []).map((v) => v.product_id).filter(Boolean))];
  const { data: assigns } = productIds.length
    ? await admin
        .from("product_pricing_rule")
        .select("product_id, pricing_rule_id")
        .eq("workspace_id", workspaceId)
        .in("product_id", productIds)
    : { data: [] as Array<{ product_id: string; pricing_rule_id: string }> };
  const ruleIdByProduct = new Map((assigns || []).map((a) => [a.product_id, a.pricing_rule_id]));

  const ruleIds = [...new Set((assigns || []).map((a) => a.pricing_rule_id))];
  const { data: rules } = ruleIds.length
    ? await admin
        .from("pricing_rules")
        .select("id, subscribe_discount_pct, quantity_breaks, free_shipping, free_shipping_threshold_cents, free_shipping_subscription_only")
        .in("id", ruleIds)
        .eq("is_active", true)
    : { data: [] as RuleRow[] };
  const ruleMap = new Map((rules || []).map((r) => [r.id, r as RuleRow]));

  const { data: ws } = await admin
    .from("workspaces")
    .select("subscription_discount_pct")
    .eq("id", workspaceId)
    .maybeSingle();
  const fallbackSns = ws?.subscription_discount_pct ?? 25;

  // 2.5 Persist-to-renewal offer. The sub carries a REFERENCE to the offer it was
  //     acquired under (pricing_offer_id), never a baked price — so the offer
  //     persists to renewal yet stays cleanly reversible. Apply it only when it is
  //     still `active` and inside its [starts_at, ends_at] window; an expired /
  //     un-approved offer reverts the sub to base pricing with no row mutation.
  //     `product_id = null` scopes the offer to every product line; otherwise only
  //     lines for that product receive the delta.
  let offer: OfferRow | null = null;
  if (sub.pricing_offer_id) {
    const { data: offerRow } = await admin
      .from("pricing_rule_offers")
      .select("id, product_id, subscribe_discount_pct, renewal_price_cents, status, starts_at, ends_at")
      .eq("id", sub.pricing_offer_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (offerRow && offerRow.status === "active") {
      const now = Date.now();
      const startsOk = !offerRow.starts_at || Date.parse(offerRow.starts_at) <= now;
      const endsOk = !offerRow.ends_at || Date.parse(offerRow.ends_at) > now;
      if (startsOk && endsOk) offer = offerRow as OfferRow;
    }
  }
  const offerApplies = (productId: string | null): boolean =>
    !!offer && (offer.product_id == null || offer.product_id === productId);

  // 3. Mix-and-match: total quantity per rule across product lines.
  const ruleTotalQty = new Map<string, number>();
  for (const i of items) {
    if (isShippingProtection(i) || i.is_gift) continue;
    const v = vmap.get(String(i.variant_id || ""));
    const ruleId = v ? ruleIdByProduct.get(v.product_id) : undefined;
    if (!ruleId) continue;
    ruleTotalQty.set(ruleId, (ruleTotalQty.get(ruleId) || 0) + (i.quantity || 0));
  }

  // 4. Price each line.
  const lines: PricedLine[] = items.map((i) => {
    const variantId = String(i.variant_id || "");
    const v = vmap.get(variantId);
    const quantity = i.quantity || 1;
    const common = {
      variant_id: variantId,
      product_id: (v?.product_id as string | undefined) || i.product_id || null,
      title: i.title || "Item",
      variant_title: i.variant_title || "",
      sku: i.sku || null,
      quantity,
      line_id: i.line_id || null,
      is_gift: !!i.is_gift,
    };

    if (isShippingProtection(i)) {
      const amt = i.price_cents ?? 0;
      return { ...common, kind: "protection" as const, base_cents: amt, unit_cents: amt, break_pct: 0, sns_pct: 0, is_grandfathered: false };
    }
    if (i.is_gift) {
      return { ...common, kind: "gift" as const, base_cents: v?.price_cents ?? 0, unit_cents: 0, break_pct: 0, sns_pct: 0, is_grandfathered: false };
    }

    const hasOverride = i.price_override_cents != null;
    // A baked per-unit price on the sub item is a CONFIGURED / GRANDFATHERED
    // lock — the customer's authoritative renewal rate. Honor it verbatim
    // instead of re-pricing off the current catalog: a catalog price that has
    // risen since acquisition would silently overcharge a grandfathered
    // customer through the S&S / quantity-break / offer decomposition path.
    // Only kicks in when no `price_override_cents` is set (that path already
    // preserves grandfathering by locking the pre-discount base).
    // Docs/brain spec: subscription-renewal-honors-configured-grandfathered-price-never-bills-standard.
    const hasBakedUnit = !hasOverride && i.price_cents != null && Number(i.price_cents) > 0;
    if (hasBakedUnit) {
      const unit = Number(i.price_cents);
      // Strikethrough = catalog MSRP when available (for "you save" math); falls
      // back to the locked unit so we never render a strike BELOW the charged.
      const strike = v?.price_cents && v.price_cents > unit ? Number(v.price_cents) : unit;
      return {
        ...common,
        kind: "product" as const,
        base_cents: strike,
        unit_cents: unit,
        break_pct: 0,
        sns_pct: 0,
        is_grandfathered: strike > unit,
      };
    }

    // Pre-migration safety: if a variant isn't in the catalog yet, fall back to
    // the legacy baked price so nothing prices to $0 mid-rollout.
    const base = hasOverride ? Number(i.price_override_cents) : (v?.price_cents ?? i.price_cents ?? 0);
    const ruleId = v ? ruleIdByProduct.get(v.product_id) : undefined;
    const rule = ruleId ? ruleMap.get(ruleId) : undefined;
    const productId = common.product_id;
    const ruleSnsPct = rule ? Number(rule.subscribe_discount_pct || 0) : fallbackSns;
    const breakPct = rule ? breakPctForQty(rule.quantity_breaks, ruleTotalQty.get(ruleId!) || quantity) : 0;

    // Persist-to-renewal offer overlay (when this line is in the offer's scope).
    // renewal_price_cents pins the per-unit charge outright; otherwise the offer's
    // subscribe_discount_pct OVERRIDES the resolved S&S % for this line. Out of
    // scope → base rule pricing, untouched.
    if (offerApplies(productId)) {
      if (offer!.renewal_price_cents != null) {
        return { ...common, kind: "product" as const, base_cents: base, unit_cents: offer!.renewal_price_cents, break_pct: 0, sns_pct: 0, is_grandfathered: hasOverride };
      }
      const offerSns = Number(offer!.subscribe_discount_pct || 0);
      const unit = Math.round(base * (1 - breakPct / 100) * (1 - offerSns / 100));
      return { ...common, kind: "product" as const, base_cents: base, unit_cents: unit, break_pct: breakPct, sns_pct: offerSns, is_grandfathered: hasOverride };
    }

    const snsPct = ruleSnsPct;
    const unit = Math.round(base * (1 - breakPct / 100) * (1 - snsPct / 100));
    return { ...common, kind: "product" as const, base_cents: base, unit_cents: unit, break_pct: breakPct, sns_pct: snsPct, is_grandfathered: hasOverride };
  });

  const productLines = lines.filter((l) => l.kind === "product");
  const product_subtotal_cents = productLines.reduce((s, l) => s + l.unit_cents * l.quantity, 0);
  const product_msrp_cents = productLines.reduce((s, l) => s + l.base_cents * l.quantity, 0);

  // 5. Free shipping. Authoritative semantics (mirrors the storefront price
  //    tables): free_shipping && (!free_shipping_subscription_only || isSubscribing).
  //    Internal subs are ALWAYS subscription-mode, so the subscription_only flag is
  //    always satisfied and the threshold does NOT gate the decision — a rule with
  //    free_shipping = true grants it outright.
  const subRules = [...ruleMap.values()];
  const free_shipping = subRules.some((r) => r.free_shipping);
  const shipping_cents = free_shipping ? 0 : Number(sub.delivery_price_cents || 0);

  // 6. Qualified-discount pills. S&S = the highest S&S any product line gets
  //    (covers rule + workspace-fallback). Quantity break = the active tier per
  //    rule ("8% OFF Buy 2"). Free shipping when granted. Coupons are appended by
  //    the caller from applied_discounts.
  const discounts: DiscountPill[] = [];
  const snsPcts = productLines.map((l) => l.sns_pct).filter((p) => p > 0);
  if (snsPcts.length) discounts.push({ kind: "sns", label: `${Math.max(...snsPcts)}% Subscribe & Save` });
  const seenBreak = new Set<string>();
  for (const [ruleId, rule] of ruleMap) {
    const totalQty = ruleTotalQty.get(ruleId) || 0;
    const brk = breakPctForQty(rule.quantity_breaks, totalQty);
    if (brk > 0) {
      const label = `${brk}% OFF Buy ${totalQty}`;
      if (!seenBreak.has(label)) { discounts.push({ kind: "quantity_break", label }); seenBreak.add(label); }
    }
  }
  if (free_shipping) discounts.push({ kind: "free_shipping", label: "Free Shipping" });
  // Persist-to-renewal offer pill — honest, owner-approved offer labeling. Only when
  // the offer actually touched a line on this sub.
  if (offer && productLines.some((l) => offerApplies(l.product_id))) {
    discounts.push({ kind: "renewal_offer", label: "Renewal Offer" });
  }

  return { lines, product_subtotal_cents, product_msrp_cents, shipping_cents, free_shipping, discounts };
}
