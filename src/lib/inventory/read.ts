import type { SupabaseClient } from "@supabase/supabase-js";

// Canonical inventory READ helper. The single source of truth for on-hand is
// inventory_levels (see docs/brain/tables/inventory_levels.md) — this replaces the two legacy
// stores readers used to reach for: the stale, backfill-only product_variants.inventory_quantity
// scalar (Store B) and the products.variants[].inventory_quantity JSONB mirror (Store A). The
// `shopify` location is the storefront-fulfilling on-hand, keyed by Shopify variant id.
//
// Why this matters: Store B froze at a backfill snapshot and read a positive qty on SKUs that
// were really OOS (incident 9a7f9481: Mixed Berry read 3,746 mid-crisis → the AI promised a
// reship that could never ship). Canonical reads the live figure (Mixed Berry = 0).

/** Live storefront (Shopify) on-hand per Shopify variant id, from canonical inventory_levels. */
export async function getShopifyOnHandByVariant(admin: SupabaseClient, workspaceId: string): Promise<Map<string, number>> {
  const { data } = await admin
    .from("inventory_levels")
    .select("variant_id, external_ref, on_hand")
    .eq("workspace_id", workspaceId)
    .eq("location", "shopify");
  const m = new Map<string, number>();
  for (const r of data ?? []) {
    const key = String(r.variant_id ?? r.external_ref ?? "");
    if (key) m.set(key, r.on_hand ?? 0);
  }
  return m;
}
