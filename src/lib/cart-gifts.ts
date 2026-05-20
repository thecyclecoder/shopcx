/**
 * Free-gift injection.
 *
 * Reads each product's pricing_rule.free_gift_* config, checks whether
 * the cart's quantity per product meets the threshold (and the
 * subscription gate is satisfied), and appends $0 gift lines. Used
 * by /api/cart on write AND by the checkout page on render so carts
 * created before the gift logic landed get the gift retroactively.
 */
import { findVariant } from "@/lib/product-variants";
import { createAdminClient } from "@/lib/supabase/admin";

export interface CartLineLike {
  variant_id: string;
  product_id: string;
  shopify_variant_id: string | null;
  title: string;
  variant_title: string | null;
  image_url: string | null;
  quantity: number;
  unit_price_cents: number;
  unit_msrp_cents: number;
  price_cents_at_add: number;
  line_total_cents: number;
  mode: "subscribe" | "onetime";
  frequency_days: number | null;
  is_gift?: boolean;
  gift_source_product_id?: string;
}

/**
 * Returns a new line_items array with qualifying free-gift lines
 * appended. Returns the original array (same reference) when no gifts
 * apply.
 */
export async function ensureFreeGifts(
  workspaceId: string,
  lines: CartLineLike[],
): Promise<CartLineLike[]> {
  if (lines.length === 0) return lines;
  // Cart "mode" — if any line is subscribing, treat the cart as a
  // subscription for gift-eligibility (matches how the PDP/customize
  // page sets the cart mode).
  const subscribing = lines.some((l) => l.mode === "subscribe");
  const cartMode: "subscribe" | "onetime" = subscribing ? "subscribe" : "onetime";

  // Already-present gift variant ids — avoid double-injecting if /api/cart
  // wrote one and we run again on render.
  const existingGiftIds = new Set(
    lines.filter((l) => l.is_gift).map((l) => l.variant_id),
  );

  // Sum non-gift qty per product so gift items themselves don't count
  // toward the threshold.
  const qtyByProduct = new Map<string, number>();
  for (const l of lines) {
    if (l.is_gift) continue;
    qtyByProduct.set(l.product_id, (qtyByProduct.get(l.product_id) || 0) + l.quantity);
  }
  if (qtyByProduct.size === 0) return lines;

  const admin = createAdminClient();
  const productIds = Array.from(qtyByProduct.keys());

  const { data: assigns } = await admin
    .from("product_pricing_rule")
    .select("product_id, pricing_rule_id")
    .eq("workspace_id", workspaceId)
    .in("product_id", productIds);
  const ruleIds = Array.from(new Set((assigns || []).map((a) => a.pricing_rule_id as string).filter(Boolean)));
  if (ruleIds.length === 0) return lines;

  const { data: rules } = await admin
    .from("pricing_rules")
    .select("id, free_gift_variant_id, free_gift_min_quantity, free_gift_subscription_only")
    .in("id", ruleIds);
  const rulesById = new Map<string, { free_gift_variant_id: string | null; free_gift_min_quantity: number; free_gift_subscription_only: boolean }>();
  for (const r of rules || []) {
    rulesById.set(r.id as string, {
      free_gift_variant_id: (r.free_gift_variant_id as string | null) || null,
      free_gift_min_quantity: (r.free_gift_min_quantity as number) || 1,
      free_gift_subscription_only: !!r.free_gift_subscription_only,
    });
  }

  const additions: CartLineLike[] = [];
  for (const [productId, totalQty] of qtyByProduct.entries()) {
    const assign = (assigns || []).find((a) => a.product_id === productId);
    if (!assign?.pricing_rule_id) continue;
    const rule = rulesById.get(assign.pricing_rule_id as string);
    if (!rule?.free_gift_variant_id) continue;
    if (rule.free_gift_subscription_only && !subscribing) continue;
    if (totalQty < rule.free_gift_min_quantity) continue;
    if (existingGiftIds.has(rule.free_gift_variant_id)) continue;

    const giftVariant = await findVariant(workspaceId, { id: rule.free_gift_variant_id });
    if (!giftVariant) continue;
    const { data: giftProduct } = await admin
      .from("products")
      .select("title")
      .eq("id", giftVariant.product_id)
      .single();
    additions.push({
      variant_id: giftVariant.id,
      product_id: giftVariant.product_id,
      shopify_variant_id: giftVariant.shopify_variant_id,
      title: giftProduct?.title || "Free gift",
      variant_title: giftVariant.title || null,
      image_url: giftVariant.image_url,
      quantity: 1,
      unit_price_cents: 0,
      unit_msrp_cents: giftVariant.price_cents,
      price_cents_at_add: 0,
      line_total_cents: 0,
      mode: cartMode,
      frequency_days: cartMode === "subscribe" ? lines.find((l) => l.frequency_days)?.frequency_days || null : null,
      is_gift: true,
      gift_source_product_id: productId,
    });
    existingGiftIds.add(rule.free_gift_variant_id);
  }

  if (additions.length === 0) return lines;
  return [...lines, ...additions];
}
