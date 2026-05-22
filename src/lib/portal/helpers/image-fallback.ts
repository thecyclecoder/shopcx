/**
 * Hydrate `image_url` on subscription + order line items by falling
 * back through the products catalog:
 *   1. Manual product_media slot='hero' (admin-uploaded storefront image)
 *   2. products.variants[].image_url matching by variant_id, sku, or
 *      variant_title (Shopify-synced per-variant image)
 *   3. products.image_url (Shopify-synced product hero)
 *
 * Server-side only — designed for SSR enrichment in /portal/[slug]/page.tsx
 * and /portal/[slug]/subscriptions/[id]/page.tsx so the customer's first
 * paint never shows a gray placeholder for an item that has a Shopify
 * image available.
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

interface VariantRow {
  id?: string;
  title?: string;
  sku?: string;
  image_url?: string;
}

interface ProductRow {
  id: string;
  shopify_product_id: string | null;
  image_url: string | null;
  variants: VariantRow[] | null;
}

interface ProductLookup {
  productImage: string;
  byVariantId: Map<string, string>;
  bySku: Map<string, string>;
  byVariantTitle: Map<string, string>;
}

/**
 * Build a lookup map keyed by both internal_id and shopify_product_id.
 * `ids` may contain either UUIDs or Shopify ids — we accept both since
 * the line items in older orders + subs use Shopify ids while newer rows
 * use the internal UUID.
 */
async function buildLookup(admin: AdminClient, workspaceId: string, ids: string[]): Promise<Map<string, ProductLookup>> {
  const map = new Map<string, ProductLookup>();
  if (ids.length === 0) return map;

  const { data: products } = await admin
    .from("products")
    .select("id, shopify_product_id, image_url, variants")
    .eq("workspace_id", workspaceId)
    .or(ids.map((id) => `id.eq.${id},shopify_product_id.eq.${id}`).join(","));

  // Manually-uploaded storefront media (slot='hero') takes precedence
  // over the Shopify-synced product image when the admin has bothered
  // to set one. Tracked in product_media keyed by our internal UUID.
  const internalIds = (products || []).map((p) => p.id);
  const heroByProduct = new Map<string, string>();
  if (internalIds.length > 0) {
    const { data: media } = await admin
      .from("product_media")
      .select("product_id, url")
      .in("product_id", internalIds)
      .eq("slot", "hero")
      .order("display_order", { ascending: true });
    for (const m of media || []) {
      if (m.url && !heroByProduct.has(m.product_id as string)) {
        heroByProduct.set(m.product_id as string, m.url as string);
      }
    }
  }

  for (const p of (products || []) as ProductRow[]) {
    const byVariantId = new Map<string, string>();
    const bySku = new Map<string, string>();
    const byVariantTitle = new Map<string, string>();
    for (const v of p.variants || []) {
      const img = v.image_url || "";
      if (!img) continue;
      if (v.id) byVariantId.set(String(v.id), img);
      if (v.sku) bySku.set(v.sku, img);
      if (v.title) byVariantTitle.set(v.title, img);
    }
    const productImage = heroByProduct.get(p.id) || p.image_url || "";
    const entry: ProductLookup = { productImage, byVariantId, bySku, byVariantTitle };
    map.set(p.id, entry);
    if (p.shopify_product_id) map.set(p.shopify_product_id, entry);
  }
  return map;
}

function resolveImage(lookup: ProductLookup | undefined, item: LineItemLike): string | null {
  if (!lookup) return null;
  const vid = item.variant_id != null ? String(item.variant_id) : "";
  const variantImg =
    (vid && lookup.byVariantId.get(vid)) ||
    (item.sku && lookup.bySku.get(item.sku)) ||
    (item.variant_title && lookup.byVariantTitle.get(item.variant_title)) ||
    "";
  return variantImg || lookup.productImage || null;
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
  // Collect every product_id we'll need to look up — across both
  // subscriptions (rows.items) and orders (rows.line_items).
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
