import type { SupabaseClient } from "@supabase/supabase-js";

// Canonical inventory READ helper. The single source of truth for on-hand is
// inventory_levels (see docs/brain/tables/inventory_levels.md) — this replaces the two legacy
// stores readers used to reach for: the stale, backfill-only product_variants.inventory_quantity
// scalar (Store B) and the products.variants[].inventory_quantity JSONB mirror (Store A). The
// `shopify` location is the STOREFRONT on-hand (the buy gate), keyed by Shopify variant id — NOT the
// ship truth. What can actually be fulfilled is the 3PL's on-hand: see getAmplifierOnHandBySku below,
// which is the authority for our inventory.
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

/**
 * ⭐ SHIP TRUTH — Amplifier 3PL on-hand, keyed by SKU (2026-08-12).
 *
 * `getShopifyOnHandByVariant` above returns the STOREFRONT figure — what Shopify will let a customer
 * buy. That is the BUY GATE, not the SHIP TRUTH. What actually determines whether an order can be
 * fulfilled is what the 3PL physically holds, and the founder is explicit that **Amplifier is the
 * authority for our inventory**.
 *
 * The two normally track each other, so the distinction is invisible until it isn't — and the moment
 * they diverge is exactly the out-of-stock incident: Shopify says available, Amplifier has none, the
 * customer buys, nothing ships. Reading only the storefront number cannot see that coming.
 *
 * Amplifier rows carry `variant_id: null` and key on the 3PL SKU (`sku` / `external_ref`), so this
 * returns a SKU-keyed map — callers join through `product_variants.sku`. Measured 2026-08-12:
 * Strawberry Lemonade `SC-TABS-SL-2` → amplifier 3 / shopify 1; Mixed Berry `SC-TABS-BERRY` →
 * amplifier 7779 / shopify 7761. (The legacy `product_variants.inventory_quantity` scalar read 3,748
 * and 3,746 — wrong for both, and the 3,746 is the same frozen figure behind incident 9a7f9481.)
 */
export async function getAmplifierOnHandBySku(admin: SupabaseClient, workspaceId: string): Promise<Map<string, number>> {
  const { data } = await admin
    .from("inventory_levels")
    .select("sku, external_ref, on_hand")
    .eq("workspace_id", workspaceId)
    .eq("location", "amplifier_3pl");
  const m = new Map<string, number>();
  for (const r of data ?? []) {
    const key = String(r.sku ?? r.external_ref ?? "").trim();
    if (key) m.set(key, r.on_hand ?? 0);
  }
  return m;
}
