/**
 * Hero-product advertising gate — the single source of truth every ad/DR/creative pipeline reads
 * to decide whether a product is one of the 6 hero SKUs the workspace actually advertises, or an
 * attachment SKU that should NEVER enter the advertising pipeline.
 *
 * Spec: docs/brain/specs/hero-product-advertising-gate.md (Phase 1).
 *
 * Adoption (Phase 2 — separate PR):
 *   - src/lib/inngest/playbook-compiler.ts + the builder-worker dr-content lane (Carrie)
 *   - src/lib/inngest/ad-creative-cadence.ts + src/lib/ads/creative-agent.ts (Dahlia)
 *   - product angle / research generation
 *   - the media-buyer product fan-out
 *
 * READ-ONLY — the flag is set at seed time by supabase/migrations/20261015000000_products_is_advertised.sql
 * and mutated only by hand for a new hero product.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Return every advertised product id for the workspace. Callers use this to filter their
 * enumerations (e.g. Dahlia's all-products select). An empty array means the workspace has no
 * hero products flagged — advertising pipelines should no-op, never fall back to "all products".
 */
export async function listAdvertisedProductIds(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<string[]> {
  const { data, error } = await admin
    .from("products")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_advertised", true);
  if (error) throw error;
  return (data ?? []).map((r: { id: string }) => r.id);
}

/**
 * Return true iff the product row's is_advertised is true. Callers use this to gate a per-product
 * dispatch (e.g. the DR-content lane inspecting one queued blueprint). A missing/deleted product
 * returns false so the caller safely skips.
 */
export async function isAdvertisedProduct(
  admin: SupabaseClient,
  productId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("products")
    .select("is_advertised")
    .eq("id", productId)
    .maybeSingle();
  if (error) throw error;
  return Boolean((data as { is_advertised?: boolean } | null)?.is_advertised);
}
