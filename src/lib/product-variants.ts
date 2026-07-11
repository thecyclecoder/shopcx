/**
 * Variant access layer.
 *
 * Source of truth is the `product_variants` table (UUID-keyed). The legacy
 * `products.variants` JSONB column is mirrored on every sync and stamped
 * with `internal_id` per element so consumers reading the JSONB still pick
 * up the UUID — but new code should read here.
 *
 * Once we move off Shopify, the JSONB mirror gets dropped.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface ProductVariant {
  id: string;                              // internal UUID — stable across Shopify deprecation
  workspace_id: string;
  product_id: string;
  shopify_variant_id: string | null;       // nullable: future internal-only variants
  sku: string | null;
  title: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  price_cents: number;
  compare_at_price_cents: number | null;
  image_url: string | null;
  weight: number | null;
  weight_unit: string | null;
  position: number;
  available: boolean;
}

// `inventory_quantity` is intentionally absent: on-hand is the canonical inventory_levels
// table's job (getShopifyOnHandByVariant), never the stale product_variants scalar.
const SELECT_COLS =
  "id, workspace_id, product_id, shopify_variant_id, sku, title, option1, option2, option3, price_cents, compare_at_price_cents, image_url, weight, weight_unit, position, available";

/**
 * Fetch all variants for a product, ordered by position.
 */
export async function getProductVariants(productId: string): Promise<ProductVariant[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("product_variants")
    .select(SELECT_COLS)
    .eq("product_id", productId)
    .order("position", { ascending: true });
  return (data || []) as ProductVariant[];
}

/**
 * Fetch one variant by any of: internal UUID, Shopify variant id, SKU.
 * Workspace-scoped to keep RLS-style isolation in service-role code.
 */
export async function findVariant(
  workspaceId: string,
  ref: { id?: string; shopifyVariantId?: string; sku?: string },
): Promise<ProductVariant | null> {
  const admin = createAdminClient();
  // Try each ref in order, FALLING BACK on a miss. The old code used
  // `if id else if shopify…`, so a present-but-unresolvable id (e.g. a Shopify
  // numeric id mistakenly in the id slot, which also errors as a non-UUID)
  // never fell back to shopify_variant_id → spurious variant_not_found.
  const tryCol = async (col: string, val: string): Promise<ProductVariant | null> => {
    const { data } = await admin
      .from("product_variants")
      .select(SELECT_COLS)
      .eq("workspace_id", workspaceId)
      .eq(col, val)
      .maybeSingle();
    return (data as ProductVariant) || null;
  };
  // Only treat `id` as a UUID lookup (a non-UUID would error the query).
  if (ref.id && /^[0-9a-f-]{36}$/i.test(ref.id)) {
    const v = await tryCol("id", ref.id);
    if (v) return v;
  }
  if (ref.shopifyVariantId) {
    const v = await tryCol("shopify_variant_id", String(ref.shopifyVariantId));
    if (v) return v;
  }
  // A UUID that isn't actually our `id` might be a Shopify variant id stored in
  // the id slot — try it there too before giving up.
  if (ref.id && !/^[0-9a-f-]{36}$/i.test(ref.id)) {
    const v = await tryCol("shopify_variant_id", ref.id);
    if (v) return v;
  }
  if (ref.sku) {
    const v = await tryCol("sku", ref.sku);
    if (v) return v;
  }
  return null;
}

/**
 * Build a map keyed by both Shopify variant id and internal UUID for fast
 * lookups across a workspace. Used by sync and analytics paths that need to
 * match whichever id is in the data.
 */
export async function getVariantIndex(workspaceId: string): Promise<{
  byShopifyId: Map<string, ProductVariant>;
  byUuid: Map<string, ProductVariant>;
}> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("product_variants")
    .select(SELECT_COLS)
    .eq("workspace_id", workspaceId);
  const byShopifyId = new Map<string, ProductVariant>();
  const byUuid = new Map<string, ProductVariant>();
  for (const v of (data || []) as ProductVariant[]) {
    byUuid.set(v.id, v);
    if (v.shopify_variant_id) byShopifyId.set(v.shopify_variant_id, v);
  }
  return { byShopifyId, byUuid };
}
