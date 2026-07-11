import type { SupabaseClient } from "@supabase/supabase-js";

// Days-of-cover engine. For each tracked finished good, computes trailing burn (finished
// units/mo, combining Amazon + Shopify + internal with case-pack multipliers) and current
// on-hand (from the canonical inventory_levels), then cover = on-hand / burn vs the measured
// lead time → the reorder signal. Mappings + multipliers come from the ported, reconciled
// qb_* tables; on-hand from inventory_levels; burn from native daily_amazon_product_snapshots
// (Amazon) + orders.line_items (Shopify + internal). See docs/brain/functions/logistics.md.

export interface CoverRow {
  bundleQbId: string;
  name: string;
  sku: string | null;
  burnPerMonth: number;      // total finished units/mo across channels
  // Fulfillment channels are NOT fungible: 3PL (Amplifier) stock ships the Shopify
  // storefront + internal/subscriber orders; FBA stock ships Amazon only. Cover is
  // therefore computed per channel — a blended number hides a storefront stockout while
  // Amazon stock sits full (exactly the Mixed Berry crisis).
  burnStorefront: number;    // Shopify + internal — fulfilled from the 3PL
  burnAmazon: number;        // fulfilled from FBA
  burnShopify: number;       // sub-split of burnStorefront, for reporting
  burnInternal: number;
  onHandStorefront: number;  // 3PL non-FBA-bound + manual — the subscriber-serving pool
  onHandAmazon: number;      // FBA fulfillable
  onHandAmazonPipeline: number; // + FBA inbound + 3PL cases staged for FBA
  coverStorefrontMonths: number | null;      // ⭐ the subscriber-protecting signal
  coverAmazonMonths: number | null;
  coverAmazonPipelineMonths: number | null;
}

// For burn, EVERY matched line depletes inventory. We only special-case our own internal
// storefront channel; everything else (web, subscription_contract*, shopify_draft_order,
// numeric Shopify app ids, null) is a Shopify-channel sale. Reporting-only split.
const INTERNAL_SOURCES = new Set(["storefront", "internal_subscription_renewal"]);
const isInternal = (s: string | null) => !!s && INTERNAL_SOURCES.has(s);

export interface TrackedGood { bundleQbId: string } // qb_items.id of the sellable bundle

/**
 * Compute cover for the given tracked bundles over a trailing window [since, until] (ISO
 * dates). `months` is the window length used to annualize burn. Reads qb_* mappings +
 * inventory_levels + native sales.
 */
export async function computeCover(
  admin: SupabaseClient,
  workspaceId: string,
  tracked: TrackedGood[],
  since: string,
  until: string,
  months: number,
): Promise<CoverRow[]> {
  const bundleIds = tracked.map((t) => t.bundleQbId);

  // qb_items (names/skus) + mappings (external refs + multipliers) for the tracked bundles + their BOM -F comps
  const [{ data: items }, { data: maps }, { data: extSkus }, { data: bom }, { data: manual }, { data: levels }] = await Promise.all([
    admin.from("qb_items").select("id, quickbooks_name, sku, item_type").eq("workspace_id", workspaceId),
    admin.from("qb_sku_mappings").select("product_id, external_id, source, unit_multiplier, active").eq("workspace_id", workspaceId).eq("active", true),
    admin.from("qb_external_skus").select("external_id, source, seller_sku").eq("workspace_id", workspaceId),
    admin.from("qb_item_bom").select("parent_id, component_id").eq("workspace_id", workspaceId),
    admin.from("qb_manual_inventory").select("product_id, quantity, active").eq("workspace_id", workspaceId),
    admin.from("inventory_levels").select("location, external_ref, on_hand, inbound").eq("workspace_id", workspaceId),
  ]);

  const itemById = new Map((items ?? []).map((i) => [i.id, i]));
  const mapsByBundle = new Map<string, typeof maps>();
  for (const m of maps ?? []) (mapsByBundle.get(m.product_id) ?? mapsByBundle.set(m.product_id, []).get(m.product_id)!).push(m);
  // Shopify variant_id → { bundle, mult }. The qb_sku_mappings shopify external_id is
  // `${shopifyProductId}-${variantId}`; we key burn matching by variant_id because
  // subscription orders carry the line with variant_id set but product_id/sku NULL/varying.
  const shopVariantToBundle = new Map<string, { bundleId: string; mult: number }>();
  for (const [bundleId, bmaps] of mapsByBundle) for (const m of bmaps ?? []) {
    if (m.source !== "shopify") continue;
    const variantId = m.external_id.split("-").pop();
    if (variantId) shopVariantToBundle.set(variantId, { bundleId, mult: m.unit_multiplier || 1 });
  }
  // seller_sku → { bundle, mult } for the internal-storefront path: internal orders carry
  // a ShopCX UUID variant_id (not a numeric Shopify one) but a stable seller_sku, so we map
  // the sku via qb_external_skus (seller_sku → shopify external_id → the variant above).
  const shopSkuToBundle = new Map<string, { bundleId: string; mult: number }>();
  for (const e of extSkus ?? []) {
    if (e.source !== "shopify" || !e.seller_sku) continue;
    const variantId = e.external_id.split("-").pop();
    const hit = variantId ? shopVariantToBundle.get(variantId) : undefined;
    if (hit) shopSkuToBundle.set(e.seller_sku, hit);
  }
  const manualByProduct = new Map<string, number>();
  for (const m of (manual ?? []).filter((r) => r.active)) manualByProduct.set(m.product_id, (manualByProduct.get(m.product_id) ?? 0) + (m.quantity ?? 0));
  // -F component per bundle (for manual on-hand), from BOM
  const fCompByBundle = new Map<string, string>();
  for (const b of bom ?? []) { const c = itemById.get(b.component_id); if (c?.sku?.endsWith("-F")) fCompByBundle.set(b.parent_id, b.component_id); }

  // inventory_levels indexed
  const fbaByAsin = new Map((levels ?? []).filter((l) => l.location === "fba").map((l) => [l.external_ref, l]));
  const tplBySku = new Map((levels ?? []).filter((l) => l.location === "amplifier_3pl").map((l) => [l.external_ref, l.on_hand]));

  // Native Amazon sales in the window (by ASIN)
  const asinSet = new Set<string>();
  for (const id of bundleIds) for (const m of mapsByBundle.get(id) ?? []) {
    if (m.source === "amazon") asinSet.add(m.external_id);
  }
  const { data: amzSales } = await admin.from("daily_amazon_product_snapshots")
    .select("asin, units, snapshot_date").eq("workspace_id", workspaceId).gte("snapshot_date", since).lte("snapshot_date", until).in("asin", Array.from(asinSet));
  const amzByAsin = new Map<string, number>();
  for (const r of amzSales ?? []) amzByAsin.set(r.asin, (amzByAsin.get(r.asin) ?? 0) + (r.units ?? 0));

  // Shopify + internal burn from orders.line_items. Match each line by numeric Shopify
  // variant_id first (load-bearing: subscription orders carry the line with variant_id set
  // but product_id/sku NULL or varying), falling back to seller_sku for the internal path.
  // PostgREST caps .select() at 1000 rows, so we MUST paginate — an un-ranged query silently
  // truncated June to its first 1000 orders and undercounted SL burn ~2x.
  const shopByBundle = new Map<string, number>(), intByBundle = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: orders } = await admin.from("orders")
      .select("source_name, line_items").eq("workspace_id", workspaceId)
      .gte("created_at", since + "T00:00:00Z").lte("created_at", until + "T23:59:59Z")
      .order("created_at").range(from, from + PAGE - 1);
    if (!orders || orders.length === 0) break;
    for (const o of orders) {
      const li = Array.isArray(o.line_items) ? o.line_items : [];
      for (const l of li as Array<{ variant_id?: string | number; sku?: string; quantity?: number }>) {
        const hit = (l.variant_id != null ? shopVariantToBundle.get(String(l.variant_id)) : undefined)
          ?? (l.sku ? shopSkuToBundle.get(l.sku) : undefined);
        if (!hit) continue;
        const q = (l.quantity ?? 0) * hit.mult;
        if (isInternal(o.source_name)) intByBundle.set(hit.bundleId, (intByBundle.get(hit.bundleId) ?? 0) + q);
        else shopByBundle.set(hit.bundleId, (shopByBundle.get(hit.bundleId) ?? 0) + q);
      }
    }
    if (orders.length < PAGE) break;
  }

  const out: CoverRow[] = [];
  for (const id of bundleIds) {
    const bundle = itemById.get(id);
    if (!bundle) continue;
    const bmaps = mapsByBundle.get(id) ?? [];
    // Shopify + internal burn already accumulated per bundle (variant_id match, mult applied)
    let burnAmz = 0, burnShop = shopByBundle.get(id) ?? 0, burnInt = intByBundle.get(id) ?? 0;
    let fbaFulfill = 0, fbaInbound = 0, tpl3 = 0, tplFbaBound = 0;
    for (const m of bmaps) {
      const mult = m.unit_multiplier || 1;
      if (m.source === "amazon") {
        burnAmz += (amzByAsin.get(m.external_id) ?? 0) * mult;
        const lv = fbaByAsin.get(m.external_id);
        fbaFulfill += Math.max(0, lv?.on_hand ?? 0) * mult;
        fbaInbound += Math.max(0, lv?.inbound ?? 0) * mult;
      } else if (m.source === "3pl") {
        const raw = Math.max(0, tplBySku.get(m.external_id) ?? 0) * mult;
        if (m.external_id.startsWith("FBA-")) tplFbaBound += raw; else tpl3 += raw;
      }
    }
    const fComp = fCompByBundle.get(id);
    const manualOnHand = (manualByProduct.get(id) ?? 0) + (fComp ? manualByProduct.get(fComp) ?? 0 : 0);

    // Per-channel monthly burn + non-fungible on-hand pools
    const burnStorefront = (burnShop + burnInt) / months; // Shopify + internal → served by 3PL
    const burnAmazon = burnAmz / months;                  // → served by FBA
    const burnPerMonth = burnStorefront + burnAmazon;
    const onHandStorefront = tpl3 + manualOnHand;         // 3PL non-FBA-bound + manual
    const onHandAmazon = fbaFulfill;                       // FBA fulfillable
    const onHandAmazonPipeline = fbaFulfill + fbaInbound + tplFbaBound; // + inbound + FBA-bound cases
    out.push({
      bundleQbId: id, name: bundle.quickbooks_name, sku: bundle.sku,
      burnPerMonth, burnStorefront, burnAmazon,
      burnShopify: burnShop / months, burnInternal: burnInt / months,
      onHandStorefront, onHandAmazon, onHandAmazonPipeline,
      coverStorefrontMonths: burnStorefront > 0 ? onHandStorefront / burnStorefront : null,
      coverAmazonMonths: burnAmazon > 0 ? onHandAmazon / burnAmazon : null,
      coverAmazonPipelineMonths: burnAmazon > 0 ? onHandAmazonPipeline / burnAmazon : null,
    });
  }
  return out;
}
