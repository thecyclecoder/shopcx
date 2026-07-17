/**
 * fix-1-mixed-id-resolver — Fix 1 of docs/brain/specs/spec-read-efficiency-for-scaling-fleet.md.
 *
 * Retires the mixed-ID `.or()` filter-string construction the security agent flagged as
 * `injection · medium` @ src/lib/portal/handlers/reviews.ts:48 (plus the identical pattern in
 * src/lib/klaviyo.ts and src/lib/portal/handlers/cancel-journey.ts). Those callsites built a
 *
 *   `.or('id.in.(uuids),shopify_product_id.in.("<sid>","<sid>")')`
 *
 * filter string by interpolating the extracted non-UUID Shopify IDs — even with today's
 * normalizer stripping most punctuation, a Shopify ID that leaked a comma / closing paren /
 * double-quote could break out of the PostgREST filter grammar. "Safe by helper" is far cheaper
 * than "safe by construction at every callsite."
 *
 * Contract:
 *   - Split the incoming mixed list into UUIDs (validated with the strict UUID regex the
 *     callsites already use) and Shopify IDs (validated with a STRICTLY NUMERIC regex — Shopify
 *     product IDs are numeric strings once `normalizeProductId` strips the `gid://shopify/…/`
 *     prefix). An input that matches neither is rejected — never crosses the wire.
 *   - Run TWO parameter-safe `.in()` queries in parallel (`.in('id', uuids)` +
 *     `.in('shopify_product_id', shopifyIds)`), one per non-empty side. Every ID crosses the wire
 *     as a PostgREST-escaped `.in()` list element that supabase-js encodes safely — no
 *     hand-composed filter grammar.
 *   - Merge + dedupe by internal `id`. Return `{ id, shopify_product_id }` per product, the
 *     minimum surface every caller reads.
 *
 * Behavior parity with the pre-Fix-1 path: same rows returned (a mixed list where both sides
 * are populated resolves via both queries; a single-side list resolves via one query — the same
 * three branches the pre-Fix-1 `if/else if/else` covered). One extra network round-trip vs the
 * pre-Fix-1 `.or()` (two parallel `.in()` calls instead of one `.or()`) — a worthy trade for
 * closing the filter-grammar injection surface, and the two queries fan out in parallel so
 * wall-clock is unchanged.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Shopify product IDs are numeric strings once `normalizeProductId` (callsites in reviews.ts +
// klaviyo.ts + cancel-journey.ts) has stripped the `gid://shopify/Product/…` prefix. Any input
// that isn't strictly digits is rejected here — never crosses the wire — so a punctuation-bearing
// ID can't slip past this validator.
const NUMERIC_ID_RE = /^\d+$/;

export interface ProductIdMatch {
  id: string;
  shopify_product_id: string | null;
}

/**
 * Resolve a mixed list of UUIDs + Shopify numeric IDs to `{ id, shopify_product_id }` rows via
 * two safe `.in()` queries + in-memory dedupe. See the module header for the security rationale.
 *
 * Returns an EMPTY array (never a `.or()` string) when both sides validate to empty — matches
 * the pre-Fix-1 no-match semantics without ever building a filter string.
 */
export async function resolveProductsByMixedIds(
  admin: SupabaseClient,
  workspaceId: string,
  mixedIds: string[],
): Promise<ProductIdMatch[]> {
  const uuids = mixedIds.filter((s) => UUID_RE.test(s));
  const shopifyIds = mixedIds.filter((s) => NUMERIC_ID_RE.test(s));
  if (!uuids.length && !shopifyIds.length) return [];

  // Fire both `.in()` queries in parallel — supabase-js query builders are thenable and resolve
  // to `{ data, error }` when awaited. Empty-side arrays skip their query entirely, so the two
  // pre-Fix-1 single-side branches map to a single-query fan-out.
  const [uuidsRes, shopifyRes] = await Promise.all([
    uuids.length
      ? admin.from("products").select("id, shopify_product_id").eq("workspace_id", workspaceId).in("id", uuids)
      : Promise.resolve({ data: null }),
    shopifyIds.length
      ? admin
          .from("products")
          .select("id, shopify_product_id")
          .eq("workspace_id", workspaceId)
          .in("shopify_product_id", shopifyIds)
      : Promise.resolve({ data: null }),
  ]);

  const seen = new Set<string>();
  const out: ProductIdMatch[] = [];
  for (const r of [uuidsRes, shopifyRes]) {
    const rows = (r.data ?? []) as Array<{ id: string | null; shopify_product_id: string | null }>;
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ id: row.id, shopify_product_id: row.shopify_product_id ?? null });
    }
  }
  return out;
}
