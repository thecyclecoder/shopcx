/**
 * Cart attachments — free gifts + offer-attached items.
 *
 * Two $0-line producers, called back-to-back at cart-build:
 *
 *   1. `ensureOfferItems` (Phase 2 of [[docs/brain/specs/offer-creator]]) — for
 *      each paid line whose anchor variant has an active row in `public.offers`,
 *      appends the offer's `included` items as $0 lines. Physical → the
 *      variant's real sku (Amplifier fulfills). Digital → no sku + a
 *      `digital_good_id` field, so the Amplifier sku-filter drops it and the
 *      `orders/created` Inngest [[digital-goods-delivery]] emails the asset.
 *
 *   2. `ensureFreeGifts` — reads each cart product's pricing_rule.free_gift_*
 *      config and appends qualifying $0 gift lines. When an active offer with
 *      `overrides_pricing_rule_gifts=true` is present for a cart's variant, the
 *      free_gift for THAT product is skipped — the offer's included items are
 *      the replacement.
 *
 * `ensureCartAttachments` is the combined entry point the routes call so both
 * runs stay in the correct order (offers first, then gifts with override
 * awareness).
 */
import { findVariant } from "@/lib/product-variants";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveOffersForVariants, type Offer } from "@/lib/offers";

export interface CartLineLike {
  variant_id: string;
  product_id: string;
  shopify_variant_id: string | null;
  sku?: string | null;
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
  /**
   * Set on lines injected by `ensureOfferItems`. Points at the ANCHOR variant
   * (the offer's `variant_id`) so Phase 3 (renewal-strip) can identify offer-
   * sourced lines and drop them when the offer's `scope='checkout_only'`.
   */
  offer_source_variant_id?: string;
  /**
   * Set on digital offer lines only — the `digital_goods.id` this line
   * references. Read by the `orders/created` Inngest [[digital-goods-delivery]]
   * function via `extractDigitalGoodIds` to email the asset. Physical offer
   * lines carry a `sku` instead.
   */
  digital_good_id?: string;
}

/**
 * Combined Phase 2 cart-build entry point: attach offer items, then
 * gifts (which internally skips products whose active offer has
 * `overrides_pricing_rule_gifts=true`). This is what `/api/cart`, the
 * checkout page, and the customize page call.
 */
export async function ensureCartAttachments(
  workspaceId: string,
  lines: CartLineLike[],
): Promise<CartLineLike[]> {
  const withOffers = await ensureOfferItems(workspaceId, lines);
  return ensureFreeGifts(workspaceId, withOffers);
}

/**
 * Phase 2 of offer-creator — for every paid line whose anchor variant has an
 * active [[offers]] row, append the offer's `included` items as $0 lines.
 *
 * Physical items → resolve to `product_variants.id` and carry the real sku
 * (Amplifier fulfills them exactly like a paid product line). Digital items →
 * resolve to `digital_goods.id` and carry NO sku + a `digital_good_id` field
 * (the `orders/created` Inngest [[digital-goods-delivery]] extracts the id
 * and emails the asset; the sku filter in
 * `src/app/api/checkout/route.ts` + `src/lib/integrations/amplifier.ts` drops
 * the line before Amplifier sees it).
 *
 * Idempotent: strips any existing `offer_source_variant_id` lines first, so
 * re-running on a healed cart re-derives from the current offer state.
 */
export async function ensureOfferItems(
  workspaceId: string,
  lines: CartLineLike[],
): Promise<CartLineLike[]> {
  if (lines.length === 0) return lines;
  const nonOfferLines = lines.filter((l) => !l.offer_source_variant_id);
  const anchorVariantIds = Array.from(
    new Set(nonOfferLines.filter((l) => !l.is_gift).map((l) => l.variant_id)),
  );
  if (anchorVariantIds.length === 0) return nonOfferLines;

  const offersByAnchor = await getActiveOffersForVariants(workspaceId, anchorVariantIds);
  if (offersByAnchor.size === 0) return nonOfferLines;

  const admin = createAdminClient();

  const additions: CartLineLike[] = [];
  const cartMode: "subscribe" | "onetime" = nonOfferLines.some((l) => l.mode === "subscribe")
    ? "subscribe"
    : "onetime";
  const anchorFreqDays = nonOfferLines.find((l) => l.frequency_days)?.frequency_days || null;

  const seen = new Set<string>();
  for (const anchor of nonOfferLines) {
    if (anchor.is_gift) continue;
    const offer = offersByAnchor.get(anchor.variant_id);
    if (!offer) continue;
    // Dedupe: the same anchor variant appearing twice in the cart only
    // fires the offer once (matches how `ensureFreeGifts` treats a repeat
    // qualifying product — one gift line, not many).
    if (seen.has(offer.id)) continue;
    seen.add(offer.id);

    for (const inc of offer.included) {
      if (inc.kind === "physical") {
        const variant = await findVariant(workspaceId, { id: inc.ref_id });
        if (!variant) continue;
        const { data: product } = await admin
          .from("products")
          .select("title, image_url")
          .eq("id", variant.product_id)
          .single();
        additions.push({
          variant_id: variant.id,
          product_id: variant.product_id,
          shopify_variant_id: variant.shopify_variant_id,
          sku: variant.sku || null,
          title: product?.title || variant.title || "Included item",
          variant_title: variant.title || null,
          image_url: variant.image_url || product?.image_url || null,
          quantity: inc.quantity,
          unit_price_cents: 0,
          unit_msrp_cents: variant.price_cents,
          price_cents_at_add: 0,
          line_total_cents: 0,
          mode: cartMode,
          frequency_days: cartMode === "subscribe" ? anchorFreqDays : null,
          is_gift: true,
          gift_source_product_id: anchor.product_id,
          offer_source_variant_id: offer.variant_id,
        });
      } else {
        // digital
        const { data: good } = await admin
          .from("digital_goods")
          .select("id, name, type")
          .eq("workspace_id", workspaceId)
          .eq("id", inc.ref_id)
          .maybeSingle();
        if (!good) continue;
        additions.push({
          // Digital lines don't reference a product_variants row — the id
          // slots are filled with the digital_good id so the line still has a
          // stable ref for identity/dedupe checks downstream. The lack of a
          // sku is what tells Amplifier + the checkout sku-filter to drop it.
          variant_id: good.id as string,
          product_id: good.id as string,
          shopify_variant_id: null,
          sku: null,
          title: (good.name as string) || "Included item",
          variant_title: null,
          image_url: null,
          quantity: inc.quantity,
          unit_price_cents: 0,
          unit_msrp_cents: 0,
          price_cents_at_add: 0,
          line_total_cents: 0,
          mode: cartMode,
          frequency_days: cartMode === "subscribe" ? anchorFreqDays : null,
          is_gift: true,
          gift_source_product_id: anchor.product_id,
          offer_source_variant_id: offer.variant_id,
          digital_good_id: good.id as string,
        });
      }
    }
  }

  if (additions.length === 0) return nonOfferLines;
  return [...nonOfferLines, ...additions];
}

/**
 * Returns a new line_items array with qualifying free-gift lines appended.
 * Returns the original array (same reference) when no gifts apply.
 *
 * When `skipGiftProductIds` is provided, any product in that set has its
 * pricing_rule free_gift skipped — an active offer with
 * `overrides_pricing_rule_gifts=true` is doing the gifting instead.
 */
export async function ensureFreeGifts(
  workspaceId: string,
  lines: CartLineLike[],
  skipGiftProductIds?: Set<string>,
): Promise<CartLineLike[]> {
  if (lines.length === 0) return lines;
  // If no explicit skip-set was passed, derive it from the offers table
  // for the current paid-line anchor variants so a caller that only knows
  // about `ensureFreeGifts` still respects the override flag.
  const overrideProductIds = skipGiftProductIds
    ? skipGiftProductIds
    : await deriveOverrideProductIds(workspaceId, lines);

  const subscribing = lines.some((l) => l.mode === "subscribe");
  const cartMode: "subscribe" | "onetime" = subscribing ? "subscribe" : "onetime";

  // Strip any existing gift lines so this run re-derives them from
  // the current rules. Heals stale metadata (image, title) on carts
  // committed before a rule was tightened up.
  //
  // Offer-sourced gift lines are preserved: they were derived by
  // `ensureOfferItems` (a distinct read path) and are re-derived on
  // its next run, not here.
  const nonGiftLines = lines.filter((l) => !l.is_gift || !!l.offer_source_variant_id);
  const existingGiftIds = new Set<string>();

  const qtyByProduct = new Map<string, number>();
  for (const l of nonGiftLines) {
    if (l.is_gift) continue;
    qtyByProduct.set(l.product_id, (qtyByProduct.get(l.product_id) || 0) + l.quantity);
  }
  if (qtyByProduct.size === 0) return nonGiftLines;

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
    .select("id, free_gift_variant_id, free_gift_min_quantity, free_gift_subscription_only, free_gift_image_url, free_gift_product_title")
    .in("id", ruleIds);
  const rulesById = new Map<string, {
    free_gift_variant_id: string | null;
    free_gift_min_quantity: number;
    free_gift_subscription_only: boolean;
    free_gift_image_url: string | null;
    free_gift_product_title: string | null;
  }>();
  for (const r of rules || []) {
    rulesById.set(r.id as string, {
      free_gift_variant_id: (r.free_gift_variant_id as string | null) || null,
      free_gift_min_quantity: (r.free_gift_min_quantity as number) || 1,
      free_gift_subscription_only: !!r.free_gift_subscription_only,
      free_gift_image_url: (r.free_gift_image_url as string | null) || null,
      free_gift_product_title: (r.free_gift_product_title as string | null) || null,
    });
  }

  const giftProductIds = new Set<string>();
  for (const rule of rulesById.values()) {
    if (!rule.free_gift_variant_id) continue;
    const v = await findVariant(workspaceId, { id: rule.free_gift_variant_id });
    if (v?.product_id) giftProductIds.add(v.product_id);
  }
  const cleanedNonGiftLines = giftProductIds.size
    ? nonGiftLines.filter((l) => l.is_gift || !giftProductIds.has(l.product_id))
    : nonGiftLines;

  qtyByProduct.clear();
  for (const l of cleanedNonGiftLines) {
    if (l.is_gift) continue;
    qtyByProduct.set(l.product_id, (qtyByProduct.get(l.product_id) || 0) + l.quantity);
  }

  const additions: CartLineLike[] = [];
  for (const [productId, totalQty] of qtyByProduct.entries()) {
    // Offer overrides the rule's free_gift for this product — the offer's
    // included items are attached by `ensureOfferItems` and no rule gift
    // fires alongside them.
    if (overrideProductIds.has(productId)) continue;

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
      .select("title, image_url")
      .eq("id", giftVariant.product_id)
      .single();
    const giftImage =
      rule.free_gift_image_url ||
      giftVariant.image_url ||
      ((giftProduct as { image_url?: string | null } | null)?.image_url) ||
      null;
    additions.push({
      variant_id: giftVariant.id,
      product_id: giftVariant.product_id,
      shopify_variant_id: giftVariant.shopify_variant_id,
      sku: giftVariant.sku || null,
      title: rule.free_gift_product_title || giftProduct?.title || "Free gift",
      variant_title: giftVariant.title || null,
      image_url: giftImage,
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

  return [...cleanedNonGiftLines, ...additions];
}

/** Derive the override skip-set from the offers table for the current
 *  paid-line anchor variants. Used when the caller hasn't already computed
 *  it (fallback path so `ensureFreeGifts` respects the flag on its own). */
async function deriveOverrideProductIds(
  workspaceId: string,
  lines: CartLineLike[],
): Promise<Set<string>> {
  const anchorVariantIds = Array.from(
    new Set(lines.filter((l) => !l.is_gift && !l.offer_source_variant_id).map((l) => l.variant_id)),
  );
  if (anchorVariantIds.length === 0) return new Set();
  const offers = await getActiveOffersForVariants(workspaceId, anchorVariantIds);
  const skip = new Set<string>();
  const variantsToLookup: Offer[] = [];
  for (const offer of offers.values()) {
    if (offer.overrides_pricing_rule_gifts) variantsToLookup.push(offer);
  }
  if (variantsToLookup.length === 0) return skip;
  // The anchor variant → product_id mapping is already carried by the
  // matching cart line, so look it up there instead of round-tripping to
  // product_variants for a single column.
  const productByVariant = new Map<string, string>();
  for (const l of lines) productByVariant.set(l.variant_id, l.product_id);
  for (const offer of variantsToLookup) {
    const pid = productByVariant.get(offer.variant_id);
    if (pid) skip.add(pid);
  }
  return skip;
}
