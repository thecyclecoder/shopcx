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

  const { data: tiers } = await admin
    .from("product_pricing_tiers")
    .select("quantity, price_cents, per_unit_cents, subscribe_discount_pct, variant_id")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("quantity", { ascending: false });
  if (!tiers || tiers.length === 0) return null;

  // Headline pack = the largest configured pack (best quantity break).
  const pack = tiers[0] as { quantity: number; price_cents: number; per_unit_cents: number | null; subscribe_discount_pct: number | null };
  const single = (tiers.find((t) => (t.quantity as number) === 1) || tiers[tiers.length - 1]) as { price_cents: number; per_unit_cents: number | null };

  const qty = Math.max(1, pack.quantity || 1);
  const unitMsrpCents = (single.per_unit_cents as number) || (single.price_cents as number) || 0;
  const packMsrpCents = unitMsrpCents * qty;

  // Quantity-break % is the gap between buying the pack vs. qty × single MSRP.
  const packListCents = (pack.price_cents as number) || packMsrpCents;
  const qtyPct = packMsrpCents > 0 ? Math.max(0, Math.round((1 - packListCents / packMsrpCents) * 100)) : 0;
  const snsPct = pack.subscribe_discount_pct ?? 25;
  const couponPct = POPUP_COUPON_PCT;

  // Multiplicative stack off the PACK MSRP.
  const multiplier = (1 - qtyPct / 100) * (1 - snsPct / 100) * (1 - couponPct / 100);
  const productPriceCents = Math.round(packMsrpCents * multiplier);
  const productDiscountCents = packMsrpCents - productPriceCents;

  // Free shipping + free gift values.
  const { data: rule } = await admin
    .from("pricing_rules")
    .select("free_gift_variant_id, free_gift_product_title")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .maybeSingle();

  let giftValueCents = 0;
  let giftTitle: string | null = null;
  const giftVariantId = (rule as { free_gift_variant_id?: string } | null)?.free_gift_variant_id || null;
  if (giftVariantId) {
    giftTitle = (rule as { free_gift_product_title?: string } | null)?.free_gift_product_title || "Free gift";
    const { data: gv } = await admin
      .from("product_variants")
      .select("price_cents")
      .or(`id.eq.${giftVariantId},shopify_variant_id.eq.${giftVariantId}`)
      .maybeSingle();
    giftValueCents = (gv?.price_cents as number) || 0;
  }

  const shippingValueCents = DEFAULT_SHIPPING_VALUE_CENTS;
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
