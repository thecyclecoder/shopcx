/**
 * Hydrate `image_url` on subscription + order line items by falling
 * through the variant-image priority chain:
 *
 *   1. product_variants.image_url — canonical UUID rows; storefront
 *      override (admin upload) wins here when present, otherwise this
 *      row carries the Shopify-synced variant image. Matched against
 *      the item by internal_id, shopify_variant_id, sku, or title.
 *   2. products.variants[].image_url — legacy JSONB mirror. Same data
 *      Shopify originally synced; used as a fallback when the
 *      canonical table doesn't have a hit.
 *   3. products.image_url — Shopify product hero. Final fallback only
 *      when no variant-level image exists anywhere.
 *
 * Server-side only — designed for SSR enrichment in /portal/[slug]/page.tsx
 * and /portal/[slug]/subscriptions/[id]/page.tsx so the customer's first
 * paint always shows whatever's available upstream.
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
  // All keyed by string. Different rows may write the same image under
  // different keys (internal_id, shopify_id, sku, title) so we keep
  // separate maps and let the caller try each in priority order.
  byKey: Map<string, string>;
}

/**
 * Build a lookup map keyed by both internal_id and shopify_product_id.
 * `ids` may contain either UUIDs or Shopify ids — we accept both since
 * the line items in older orders + subs use Shopify ids while newer
 * rows use the internal UUID.
 */
async function buildLookup(admin: AdminClient, workspaceId: string, ids: string[]): Promise<Map<string, ProductLookup>> {
  const map = new Map<string, ProductLookup>();
  if (ids.length === 0) return map;

  const { data: products } = await admin
    .from("products")
    .select("id, shopify_product_id, image_url, variants")
    .eq("workspace_id", workspaceId)
    .or(ids.map((id) => `id.eq.${id},shopify_product_id.eq.${id}`).join(","));

  const internalProductIds = (products || []).map((p) => p.id);

  // Pull product_variants — canonical UUID rows. Storefront overrides
  // live here; if no override, the row still carries the Shopify image
  // mirrored from Shopify sync.
  const variantsByProduct = new Map<string, Array<{
    id?: string;
    shopify_variant_id?: string | null;
    sku?: string | null;
    title?: string | null;
    image_url?: string | null;
  }>>();
  if (internalProductIds.length > 0) {
    const { data: pvs } = await admin
      .from("product_variants")
      .select("id, shopify_variant_id, sku, title, image_url, product_id")
      .in("product_id", internalProductIds);
    for (const pv of pvs || []) {
      const arr = variantsByProduct.get(pv.product_id as string) || [];
      arr.push(pv);
      variantsByProduct.set(pv.product_id as string, arr);
    }
  }

  for (const p of (products || []) as Array<{ id: string; shopify_product_id: string | null; image_url: string | null; variants: Array<{ id?: string; sku?: string; title?: string; image_url?: string; internal_id?: string }> | null }>) {
    const byKey = new Map<string, string>();

    // Layer 2 first (legacy JSONB) — gives us a baseline by every key
    // shape it knows about. Layer 1 then overwrites where it has a
    // better value.
    for (const v of p.variants || []) {
      const img = v.image_url || "";
      if (!img) continue;
      if (v.id) byKey.set(String(v.id), img);
      if (v.internal_id) byKey.set(String(v.internal_id), img);
      if (v.sku) byKey.set(v.sku, img);
      if (v.title) byKey.set(v.title, img);
    }

    // Layer 1 (canonical product_variants table) — storefront overrides
    // win here. Index by every key shape the line items might carry.
    for (const pv of variantsByProduct.get(p.id) || []) {
      const img = pv.image_url || "";
      if (!img) continue;
      if (pv.id) byKey.set(pv.id, img);
      if (pv.shopify_variant_id) byKey.set(pv.shopify_variant_id, img);
      if (pv.sku) byKey.set(pv.sku, img);
      if (pv.title) byKey.set(pv.title, img);
    }

    const entry: ProductLookup = { productImage: p.image_url || "", byKey };
    map.set(p.id, entry);
    if (p.shopify_product_id) map.set(p.shopify_product_id, entry);
  }
  return map;
}

function resolveImage(lookup: ProductLookup | undefined, item: LineItemLike): string | null {
  if (!lookup) return null;
  const tryKeys: string[] = [];
  if (item.variant_id != null) tryKeys.push(String(item.variant_id));
  if (item.sku) tryKeys.push(item.sku);
  if (item.variant_title) tryKeys.push(item.variant_title);
  for (const k of tryKeys) {
    const hit = lookup.byKey.get(k);
    if (hit) return hit;
  }
  return lookup.productImage || null;
}

/**
 * Walk a list of subscription rows (or order rows — same shape) and
 * fill in `image_url` on each line item that doesn't have one.
 * Returns the rows with their items array rewritten — non-mutating
 * so the caller can hand them to React props safely.
 */
export async function enrichLineItemImages<
  T extends { items?: LineItemLike[] | unknown; line_items?: LineItemLike[] | unknown },
>(admin: AdminClient, workspaceId: string, rows: T[]): Promise<T[]> {
  const ids = new Set<string>();
  for (const r of rows) {
    const items = (Array.isArray(r.items) ? r.items : Array.isArray(r.line_items) ? r.line_items : []) as LineItemLike[];
    for (const it of items) {
      if (it.product_id) ids.add(String(it.product_id));
    }
  }
  if (ids.size === 0) return rows;

  const lookup = await buildLookup(admin, workspaceId, [...ids]);

  return rows.map((r) => {
    const itemsField = Array.isArray(r.items) ? "items" : "line_items";
    const items = (r as Record<string, unknown>)[itemsField] as LineItemLike[] | undefined;
    if (!Array.isArray(items)) return r;
    const next = items.map((it) => {
      if (it.image_url) return it;
      const img = it.product_id ? resolveImage(lookup.get(String(it.product_id)), it) : null;
      return img ? { ...it, image_url: img } : it;
    });
    return { ...r, [itemsField]: next };
  });
}
