/**
 * Hydrate `image_url` on subscription + order line items.
 *
 * Image priority on each item:
 *   1. product_variants.image_url — canonical UUID rows. Storefront
 *      overrides win here; otherwise the row carries the
 *      Shopify-synced variant image. Matched by internal_id,
 *      shopify_variant_id, sku, or title.
 *   2. products.variants[].image_url — legacy JSONB mirror.
 *   3. products.image_url — Shopify product hero (final fallback).
 *   4. item.image_url already stamped on the row (safety net).
 *
 * Two index paths so we work for both subscription items (have
 * product_id) and order line items (often have only variant_id):
 *   - Direct: variant_id → image_url, sourced from product_variants
 *     (resolves orders that don't carry product_id)
 *   - Indirect: product_id → byKey map, used when product_id is set
 *
 * Server-side only — designed for SSR enrichment in
 * /portal/[slug]/page.tsx and /portal/[slug]/subscriptions/[id]/page.tsx.
 */

import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

interface LineItemLike {
  product_id?: string | null;
  variant_id?: string | number | null;
  sku?: string | null;
  variant_title?: string | null;
  image_url?: string | null;
}

interface ProductLookup {
  productImage: string;
  byKey: Map<string, string>;
}

interface BuildResult {
  byProduct: Map<string, ProductLookup>;
  byVariantKey: Map<string, string>;
}

async function buildLookup(
  admin: AdminClient,
  workspaceId: string,
  productIds: string[],
  variantIds: string[],
): Promise<BuildResult> {
  const byProduct = new Map<string, ProductLookup>();
  const byVariantKey = new Map<string, string>();

  // Partition by id-shape because mixing UUIDs and Shopify numeric
  // strings inside one .or() makes Postgres reject the entire query
  // with "invalid input syntax for type uuid".
  const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

  // Step 1 — variant-direct lookup. Resolves orders whose line items
  // carry only a variant_id. Match either by internal id or by
  // shopify_variant_id, since older order rows store Shopify ids and
  // newer ones store UUIDs.
  const variantProductIds: string[] = [];
  if (variantIds.length > 0) {
    const vUuids = variantIds.filter(isUuid);
    const vShopify = variantIds.filter((s) => !isUuid(s));
    let q = admin
      .from("product_variants")
      .select("id, shopify_variant_id, product_id, sku, title, image_url")
      .eq("workspace_id", workspaceId);
    if (vUuids.length > 0 && vShopify.length > 0) {
      q = q.or(`id.in.(${vUuids.join(",")}),shopify_variant_id.in.(${vShopify.map(s => `"${s}"`).join(",")})`);
    } else if (vUuids.length > 0) {
      q = q.in("id", vUuids);
    } else {
      q = q.in("shopify_variant_id", vShopify);
    }
    const { data: pvs } = await q;
    for (const pv of pvs || []) {
      const img = pv.image_url || "";
      if (img) {
        if (pv.id) byVariantKey.set(String(pv.id), img);
        if (pv.shopify_variant_id) byVariantKey.set(String(pv.shopify_variant_id), img);
        if (pv.sku) byVariantKey.set(String(pv.sku), img);
        if (pv.title) byVariantKey.set(String(pv.title), img);
      }
      // Use the variant rows to also seed product_ids we should look
      // up so we can compose the per-product fallback chain even when
      // the caller never gave us a product_id.
      if (pv.product_id) variantProductIds.push(pv.product_id as string);
    }
  }

  // Step 2 — product-level lookup. Loads each product's variants JSONB
  // (legacy) and product_variants rows (canonical, storefront override
  // wins). Both layers feed the same byKey map; canonical writes last
  // so it overwrites the JSONB baseline where present.
  const allProductIds = Array.from(new Set([...productIds, ...variantProductIds]));
  if (allProductIds.length === 0) return { byProduct, byVariantKey };

  const pUuids = allProductIds.filter(isUuid);
  const pShopify = allProductIds.filter((s) => !isUuid(s));
  let pq = admin
    .from("products")
    .select("id, shopify_product_id, image_url, variants")
    .eq("workspace_id", workspaceId);
  if (pUuids.length > 0 && pShopify.length > 0) {
    pq = pq.or(`id.in.(${pUuids.join(",")}),shopify_product_id.in.(${pShopify.map(s => `"${s}"`).join(",")})`);
  } else if (pUuids.length > 0) {
    pq = pq.in("id", pUuids);
  } else {
    pq = pq.in("shopify_product_id", pShopify);
  }
  const { data: products } = await pq;

  const internalProductIds = (products || []).map((p) => p.id);
  const pvByProduct = new Map<string, Array<{ id?: string; shopify_variant_id?: string | null; sku?: string | null; title?: string | null; image_url?: string | null }>>();
  if (internalProductIds.length > 0) {
    const { data: pvs } = await admin
      .from("product_variants")
      .select("id, shopify_variant_id, product_id, sku, title, image_url")
      .in("product_id", internalProductIds);
    for (const pv of pvs || []) {
      const arr = pvByProduct.get(pv.product_id as string) || [];
      arr.push(pv);
      pvByProduct.set(pv.product_id as string, arr);
    }
  }

  for (const p of (products || []) as Array<{ id: string; shopify_product_id: string | null; image_url: string | null; variants: Array<{ id?: string; sku?: string; title?: string; image_url?: string; internal_id?: string }> | null }>) {
    const byKey = new Map<string, string>();
    for (const v of p.variants || []) {
      const img = v.image_url || "";
      if (!img) continue;
      if (v.id) byKey.set(String(v.id), img);
      if (v.internal_id) byKey.set(String(v.internal_id), img);
      if (v.sku) byKey.set(v.sku, img);
      if (v.title) byKey.set(v.title, img);
    }
    for (const pv of pvByProduct.get(p.id) || []) {
      const img = pv.image_url || "";
      if (!img) continue;
      if (pv.id) byKey.set(pv.id, img);
      if (pv.shopify_variant_id) byKey.set(pv.shopify_variant_id, img);
      if (pv.sku) byKey.set(pv.sku, img);
      if (pv.title) byKey.set(pv.title, img);
    }
    const entry: ProductLookup = { productImage: p.image_url || "", byKey };
    byProduct.set(p.id, entry);
    if (p.shopify_product_id) byProduct.set(p.shopify_product_id, entry);
  }
  return { byProduct, byVariantKey };
}

function resolveImage(
  byProduct: Map<string, ProductLookup>,
  byVariantKey: Map<string, string>,
  item: LineItemLike,
): string | null {
  // Layer A — direct variant lookup (works without product_id).
  const tryVariantKeys: string[] = [];
  if (item.variant_id != null) tryVariantKeys.push(String(item.variant_id));
  if (item.sku) tryVariantKeys.push(item.sku);
  if (item.variant_title) tryVariantKeys.push(item.variant_title);
  for (const k of tryVariantKeys) {
    const hit = byVariantKey.get(k);
    if (hit) return hit;
  }

  // Layer B — product-scoped lookup, when product_id is available.
  if (item.product_id) {
    const lookup = byProduct.get(String(item.product_id));
    if (lookup) {
      for (const k of tryVariantKeys) {
        const hit = lookup.byKey.get(k);
        if (hit) return hit;
      }
      if (lookup.productImage) return lookup.productImage;
    }
  }

  return null;
}

/**
 * Walk a list of subscription rows (or order rows — same shape) and
 * fill in `image_url` on each line item that doesn't have one.
 */
export async function enrichLineItemImages<
  T extends { items?: LineItemLike[] | unknown; line_items?: LineItemLike[] | unknown },
>(admin: AdminClient, workspaceId: string, rows: T[]): Promise<T[]> {
  const productIds = new Set<string>();
  const variantIds = new Set<string>();
  for (const r of rows) {
    const items = (Array.isArray(r.items) ? r.items : Array.isArray(r.line_items) ? r.line_items : []) as LineItemLike[];
    for (const it of items) {
      if (it.image_url) continue;
      if (it.product_id) productIds.add(String(it.product_id));
      if (it.variant_id != null) variantIds.add(String(it.variant_id));
    }
  }
  if (productIds.size === 0 && variantIds.size === 0) return rows;

  const { byProduct, byVariantKey } = await buildLookup(
    admin,
    workspaceId,
    [...productIds],
    [...variantIds],
  );

  return rows.map((r) => {
    const itemsField = Array.isArray(r.items) ? "items" : "line_items";
    const items = (r as Record<string, unknown>)[itemsField] as LineItemLike[] | undefined;
    if (!Array.isArray(items)) return r;
    const next = items.map((it) => {
      if (it.image_url) return it;
      const img = resolveImage(byProduct, byVariantKey, it);
      return img ? { ...it, image_url: img } : it;
    });
    return { ...r, [itemsField]: next };
  });
}
