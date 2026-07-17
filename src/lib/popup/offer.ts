/**
 * Smart-popup offer computation (storefront-mvp Phase 4c).
 *
 * The advertised offer is the WHOLE value stack, not just the price cut:
 *   price discount  = 3-pack quantity break × subscribe-and-save × the
 *                     15% signup coupon, applied MULTIPLICATIVELY
 *                     (1 − 0.88×0.75×0.85 ≈ 44% off product MSRP — adding
 *                     them would overstate it at 52%)
 *   + free shipping (waive the standard rate)
 *   + a free mixer  (the product's configured free-gift line)
 *
 * Advertised value = product-discount $ + free-shipping value + gift MSRP,
 * surfaced as a $ saved AND an effective % off the full retail bundle.
 * Computed LIVE from the product's pricing tiers + rule so it never goes
 * stale; the build prints the current number.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { findVariant } from "@/lib/product-variants";

/** The signup coupon stacked on top of qty-break + S&S. */
export const POPUP_COUPON_PCT = 15;

/** Standard shipping we waive — representative rate (no address at popup time). */
const DEFAULT_SHIPPING_VALUE_CENTS = 695;

export interface PopupOffer {
  pack_quantity: number;
  coupon_pct: number;
  sns_pct: number;
  qty_pct: number;
  /** Effective % off the full retail bundle (product MSRP + shipping + gift). */
  effective_pct: number;
  product_msrp_cents: number; // pack MSRP (qty × unit MSRP)
  product_price_cents: number; // after the full multiplicative stack
  product_discount_cents: number;
  shipping_value_cents: number;
  gift_value_cents: number;
  gift_title: string | null;
  bundle_msrp_cents: number;
  total_savings_cents: number;
}

/**
 * Compute the live stacked offer for a product. Picks the highest
 * multi-pack tier as the headline pack (the 3-pack on Amazing Coffee).
 * Returns null when the product has no usable pricing tiers.
 */
export async function computePopupOffer(workspaceId: string, productId: string): Promise<PopupOffer | null> {
  const admin = createAdminClient();

  // Pricing lives in pricing_rules (via the product_pricing_rule join), NOT the
  // unused product_pricing_tiers table. quantity_breaks carry the multi-pack %.
  const { data: assign } = await admin
    .from("product_pricing_rule")
    .select("pricing_rule_id")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .maybeSingle();
  type RuleShape = { quantity_breaks?: Array<{ quantity: number; discount_pct: number }>; subscribe_discount_pct?: number; free_shipping?: boolean; free_gift_variant_id?: string | null; free_gift_product_title?: string | null };
  let rule: RuleShape | null = null;
  if (assign?.pricing_rule_id) {
    const { data } = await admin
      .from("pricing_rules")
      .select("quantity_breaks, subscribe_discount_pct, free_shipping, free_gift_variant_id, free_gift_product_title")
      .eq("id", assign.pricing_rule_id)
      .maybeSingle();
    rule = (data as RuleShape) || null;
  }

  // Base unit MSRP = the product's variant price (anchor at compare_at when higher).
  const { data: v } = await admin
    .from("product_variants")
    .select("price_cents, compare_at_price_cents")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("price_cents", { ascending: true })
    .limit(1)
    .maybeSingle();
  const unitMsrpCents = Math.max(Number(v?.price_cents) || 0, Number((v as { compare_at_price_cents?: number } | null)?.compare_at_price_cents) || 0);
  if (!unitMsrpCents) return null;

  // Headline pack = the biggest quantity break (e.g. the 3-pack, 12% off).
  const breaks = (rule?.quantity_breaks || []).filter((b) => Number(b.quantity) >= 1).sort((a, b) => b.quantity - a.quantity);
  const pack = breaks[0] || { quantity: 1, discount_pct: 0 };
  const qty = Math.max(1, Number(pack.quantity) || 1);
  const qtyPct = Math.max(0, Number(pack.discount_pct) || 0);
  const snsPct = Number(rule?.subscribe_discount_pct ?? 25);
  const couponPct = POPUP_COUPON_PCT;

  const packMsrpCents = unitMsrpCents * qty;
  // Multiplicative stack off the PACK MSRP.
  const multiplier = (1 - qtyPct / 100) * (1 - snsPct / 100) * (1 - couponPct / 100);
  const productPriceCents = Math.round(packMsrpCents * multiplier);
  const productDiscountCents = packMsrpCents - productPriceCents;

  // Free gift value (when the rule grants one).
  let giftValueCents = 0;
  let giftTitle: string | null = null;
  const giftVariantId = rule?.free_gift_variant_id || null;
  if (giftVariantId) {
    giftTitle = rule?.free_gift_product_title || "Free gift";
    // free_gift_variant_id is admin-writable TEXT and may hold a UUID or a
    // Shopify numeric id. Route through findVariant so a numeric id doesn't
    // get cast to uuid on product_variants.id (Postgres 22P02 → gift $0).
    const gv = await findVariant(workspaceId, { id: giftVariantId, shopifyVariantId: giftVariantId });
    giftValueCents = gv?.price_cents || 0;
  }

  // Free shipping is only a stack value when the rule actually grants it.
  const shippingValueCents = rule?.free_shipping ? DEFAULT_SHIPPING_VALUE_CENTS : 0;
  const bundleMsrpCents = packMsrpCents + shippingValueCents + giftValueCents;
  const totalSavingsCents = productDiscountCents + shippingValueCents + giftValueCents;
  const effectivePct = bundleMsrpCents > 0 ? Math.round((totalSavingsCents / bundleMsrpCents) * 100) : 0;

  return {
    pack_quantity: qty,
    coupon_pct: couponPct,
    sns_pct: snsPct,
    qty_pct: qtyPct,
    effective_pct: effectivePct,
    product_msrp_cents: packMsrpCents,
    product_price_cents: productPriceCents,
    product_discount_cents: productDiscountCents,
    shipping_value_cents: shippingValueCents,
    gift_value_cents: giftValueCents,
    gift_title: giftTitle,
    bundle_msrp_cents: bundleMsrpCents,
    total_savings_cents: totalSavingsCents,
  };
}
