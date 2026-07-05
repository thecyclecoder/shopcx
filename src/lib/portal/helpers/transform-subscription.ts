// Transform a commerce SDK SubscriptionView into the frontend contract shape.
// Bridges: SubscriptionView (from @/lib/commerce/subscription) → Frontend
// (camelCase, lines[], MoneyV2). All money already resolved by the SDK's
// priceSubscription — this layer only reshapes fields and resolves images.
//
// Image priority on each line item:
//   1. product_variants.image_url — canonical UUID rows. Storefront
//      overrides (admin upload) win here; otherwise this row carries
//      the Shopify-synced variant image. Matched by internal_id,
//      shopify_variant_id, sku, or variant_title.
//   2. products.variants[].image_url — legacy JSONB mirror. Same data
//      Shopify originally synced; used as a fallback when the
//      canonical table doesn't have a hit.
//   3. products.image_url — Shopify product hero. Final fallback only
//      when no variant-level image exists anywhere.

import type { SubscriptionLineView, SubscriptionView } from "@/lib/commerce/subscription";

interface ProductInfo {
  productImage: string;
  // Single map indexed by every key shape line items might carry —
  // internal variant UUID, Shopify variant id, sku, or title. The
  // caller tries each in priority order.
  byKey: Map<string, string>;
}

interface ProductMap {
  [productId: string]: ProductInfo;
}

function resolveLineImage(info: ProductInfo | undefined, item: SubscriptionLineView): string {
  if (!info) return "";
  const tryKeys: string[] = [];
  if (item.variant_id) tryKeys.push(String(item.variant_id));
  if (item.sku) tryKeys.push(item.sku);
  if (item.variant_title) tryKeys.push(item.variant_title);
  for (const k of tryKeys) {
    const hit = info.byKey.get(k);
    if (hit) return hit;
  }
  return info.productImage || "";
}

export function transformSubscription(
  sub: SubscriptionView,
  productMap: ProductMap = {}
) {
  const lines = sub.items.map((item) => {
    const pid = item.product_id || "";
    const product = productMap[pid];
    const imageUrl = resolveLineImage(product, item);

    // The SDK's price resolver puts the charged unit price on
    // `unit_cents` and the strikethrough MSRP on `base_cents`. Surface
    // both so the frontend can render a strikethrough when a discount
    // applies (base > unit).
    const unitCents = item.unit_cents;
    const baseCents = item.base_cents;

    return {
      // Appstle lines carry a Shopify line_id; internal lines don't
      // (they key on the variant_id UUID). Falling back to variant_id
      // gives every line a stable identifier the portal can send back
      // for swap/remove/qty — the backend handlers match this against
      // the internal sub's variant_id.
      id: item.line_id || String(item.variant_id || "") || "",
      title: item.title || "Item",
      variantTitle: item.variant_title || "",
      quantity: item.quantity || 1,
      variantId: item.variant_id || "",
      productId: pid,
      sku: item.sku || "",
      currentPrice: {
        amount: (unitCents / 100).toFixed(2),
        currencyCode: "USD",
      },
      basePrice: baseCents > unitCents
        ? { amount: (baseCents / 100).toFixed(2), currencyCode: "USD" }
        : null,
      variantImage: {
        transformedSrc: imageUrl,
      },
      is_gift: !!item.is_gift,
    };
  });

  return {
    // `id` is the Shopify contract id for compatibility with existing
    // mini-site/extension consumers. `internal_id` is our row UUID,
    // which the new admin-styled portal uses in its URLs so links
    // survive the eventual Shopify cutover.
    id: sub.shopify_contract_id || sub.id,
    internal_id: sub.id,
    shopify_contract_id: sub.shopify_contract_id,
    is_internal: sub.is_internal,
    // Internal subs track shipping protection on the row (the renewal
    // bills from it), not as a line item — surface it so the toggle +
    // summary use one source.
    shipping_protection_added: !!sub.shipping_protection_added,
    shipping_protection_amount_cents: Number(sub.shipping_protection_amount_cents || 0),
    status: String(sub.status || "active").toUpperCase(),
    lastPaymentStatus: String(sub.last_payment_status || "SUCCEEDED").toUpperCase(),
    billingPolicy: {
      interval: String(sub.billing_interval || "WEEK").toUpperCase(),
      intervalCount: Number(sub.billing_interval_count) || 4,
    },
    nextBillingDate: sub.next_billing_date || null,
    pause_resume_at: sub.pause_resume_at || null,
    lines,
    createdAt: sub.created_at,
    updatedAt: sub.updated_at,
    // deliveryMethod is resolved from the sub's shipping_address by the
    // detail handler; the list handler leaves it null.
    deliveryMethod: null as { address?: Record<string, unknown> } | null,
  };
}

interface DbJsonbVariant {
  id?: string;
  internal_id?: string;
  title?: string;
  sku?: string;
  image_url?: string;
}

interface DbProductVariant {
  id?: string;
  shopify_variant_id?: string | null;
  product_id?: string;
  title?: string | null;
  sku?: string | null;
  image_url?: string | null;
}

export async function getProductMap(
  admin: ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>,
  workspaceId: string,
  productIds: string[],
  variantIds: string[] = [],
): Promise<ProductMap> {
  if (!productIds.length && !variantIds.length) return {};

  // Partition each set by id shape — UUIDs go to the `id`/`product_id`
  // columns, numeric Shopify ids go to `shopify_*_id`. Mixing them in
  // a single OR makes Postgres reject the whole query with "invalid
  // input syntax for type uuid" when any branch passes a numeric
  // string to a UUID column.
  const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  const variantUuids = variantIds.filter(isUuid);
  const variantShopifyIds = variantIds.filter((s) => !isUuid(s));

  // Variant-direct seed pass — when subscription items carry only a
  // variant_id (or carry a variant_id we can't link to a product via
  // the product_ids set) we still need a way to find the product.
  const variantSeededProductIds: string[] = [];
  if (variantUuids.length > 0 || variantShopifyIds.length > 0) {
    let q = admin.from("product_variants").select("product_id").eq("workspace_id", workspaceId);
    if (variantUuids.length > 0 && variantShopifyIds.length > 0) {
      q = q.or(`id.in.(${variantUuids.join(",")}),shopify_variant_id.in.(${variantShopifyIds.map(s => `"${s}"`).join(",")})`);
    } else if (variantUuids.length > 0) {
      q = q.in("id", variantUuids);
    } else {
      q = q.in("shopify_variant_id", variantShopifyIds);
    }
    const { data: pvSeed } = await q;
    for (const pv of pvSeed || []) {
      if (pv.product_id) variantSeededProductIds.push(pv.product_id as string);
    }
  }
  const allProductIds = Array.from(new Set([...productIds, ...variantSeededProductIds]));
  if (allProductIds.length === 0) return {};

  const productUuids = allProductIds.filter(isUuid);
  const productShopifyIds = allProductIds.filter((s) => !isUuid(s));

  // Look up products by id-shape. Same UUID/numeric split as above so
  // Postgres doesn't reject the query.
  let prodQuery = admin.from("products")
    .select("id, shopify_product_id, image_url, variants")
    .eq("workspace_id", workspaceId);
  if (productUuids.length > 0 && productShopifyIds.length > 0) {
    prodQuery = prodQuery.or(`id.in.(${productUuids.join(",")}),shopify_product_id.in.(${productShopifyIds.map(s => `"${s}"`).join(",")})`);
  } else if (productUuids.length > 0) {
    prodQuery = prodQuery.in("id", productUuids);
  } else {
    prodQuery = prodQuery.in("shopify_product_id", productShopifyIds);
  }
  const { data: products, error: prodErr } = await prodQuery;

  if (prodErr) console.error("[getProductMap] query error:", prodErr.message, "productIds:", allProductIds);

  const internalProductIds = (products || []).map((p) => p.id);

  // Pull canonical product_variants rows for these products.
  // Storefront overrides (manual uploads) live here; when there's no
  // override the row still holds the Shopify-mirrored image.
  const pvByProduct = new Map<string, DbProductVariant[]>();
  if (internalProductIds.length > 0) {
    const { data: pvs } = await admin
      .from("product_variants")
      .select("id, shopify_variant_id, product_id, title, sku, image_url")
      .in("product_id", internalProductIds);
    for (const pv of pvs || []) {
      const arr = pvByProduct.get(pv.product_id as string) || [];
      arr.push(pv as DbProductVariant);
      pvByProduct.set(pv.product_id as string, arr);
    }
  }

  const map: ProductMap = {};
  for (const p of products || []) {
    const byKey = new Map<string, string>();

    // Layer 1 — legacy variants JSONB. Same Shopify image data as
    // product_variants; populated by older sync paths. Used as the
    // baseline so when a brand-new product hasn't had its
    // product_variants row written yet, we still have an image.
    const jsonbVariants = Array.isArray(p.variants) ? (p.variants as DbJsonbVariant[]) : [];
    for (const v of jsonbVariants) {
      const img = v.image_url || "";
      if (!img) continue;
      if (v.id) byKey.set(String(v.id), img);
      if (v.internal_id) byKey.set(String(v.internal_id), img);
      if (v.sku) byKey.set(v.sku, img);
      if (v.title) byKey.set(v.title, img);
    }

    // Layer 2 — canonical product_variants table. Storefront overrides
    // win here, so writes here overwrite whatever Layer 1 contributed.
    for (const pv of pvByProduct.get(p.id) || []) {
      const img = pv.image_url || "";
      if (!img) continue;
      if (pv.id) byKey.set(pv.id, img);
      if (pv.shopify_variant_id) byKey.set(pv.shopify_variant_id, img);
      if (pv.sku) byKey.set(pv.sku, img);
      if (pv.title) byKey.set(pv.title, img);
    }

    const entry: ProductInfo = { productImage: p.image_url || "", byKey };
    // Index by both ID shapes so the line item can look up by either.
    map[p.id] = entry;
    if (p.shopify_product_id) map[p.shopify_product_id] = entry;
  }
  return map;
}
