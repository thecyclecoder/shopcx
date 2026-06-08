/**
 * Internal-subscription pricing engine — the single source of truth for what an
 * internal sub costs, used by BOTH the portal display and the renewal scheduler.
 *
 * Philosophy (Dylan, 2026-06): a subscription stores catalog *references*, not
 * baked prices. The only price a sub row may carry is a **grandfathered override**
 * (`items[].price_override_cents`). Everything else is derived live from the
 * catalog + the product's pricing rule, so a price change in the catalog or a
 * rule flows through automatically — nothing is hard-coded into the row.
 *
 * Rules, applied per line (multiplicative — see docs/brain/specs/storefront-mvp.md):
 *   base   = price_override_cents (grandfathered) ?? catalog product_variants.price_cents
 *   break% = quantity-break tier for the MIX-AND-MATCH total quantity of all lines
 *            sharing the line's pricing_rule (2 different flavors on the same rule
 *            → the qty-2 tier). Lines with no rule get no break.
 *   sns%   = pricing_rule.subscribe_discount_pct, else workspace.subscription_discount_pct
 *   unit   = round(base × (1 − break%/100) × (1 − sns%/100))
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
  /** Legacy baked price — read only as a pre-migration fallback when a variant
   *  isn't found in the catalog. New code never writes this. */
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

export interface SubscriptionPricing {
  lines: PricedLine[];
  /** Σ unit_cents × qty over *product* lines only — the discountable base. */
  product_subtotal_cents: number;
  /** Σ base_cents × qty over product lines — for "you save X" math. */
  product_msrp_cents: number;
  /** Resolved shipping for this renewal (0 when a rule grants free shipping). */
  shipping_cents: number;
  free_shipping: boolean;
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
  sub: { items?: unknown; delivery_price_cents?: number | null },
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
    // Pre-migration safety: if a variant isn't in the catalog yet, fall back to
    // the legacy baked price so nothing prices to $0 mid-rollout.
    const base = hasOverride ? Number(i.price_override_cents) : (v?.price_cents ?? i.price_cents ?? 0);
    const ruleId = v ? ruleIdByProduct.get(v.product_id) : undefined;
    const rule = ruleId ? ruleMap.get(ruleId) : undefined;
    const snsPct = rule ? Number(rule.subscribe_discount_pct || 0) : fallbackSns;
    const breakPct = rule ? breakPctForQty(rule.quantity_breaks, ruleTotalQty.get(ruleId!) || quantity) : 0;
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

  return { lines, product_subtotal_cents, product_msrp_cents, shipping_cents, free_shipping };
}
