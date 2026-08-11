/**
 * qb-close/sync-sources — keeps the close's `qb_*` source tables fed from ShopCX's OWN
 * integrations, so a month can be closed without hand-porting data out of Shoptics.
 *
 * Each sync is idempotent (upsert on the table's natural key) and safe to re-run for a date
 * range. Read-only against the upstream APIs; never writes QuickBooks.
 *
 * ⭐ **These read the RAW integrations, not ShopCX's `public.inventory_snapshots`.** That table
 * is a lossy logistics view: it drops FBA `reserved` entirely, and for the 3PL it stores
 * Amplifier's `quantity_available` in a column *named* `on_hand`. The close needs
 * `quantity_on_hand` (= available + committed) and needs `reserved` to compute `transit`, so
 * reading the convenience table would silently reintroduce the exact two bugs that made July's
 * first dry run report an $85,864 adjustment.
 *
 * ⚠️ **Amazon SALES is deliberately NOT synced here.** ShopCX's `daily_amazon_product_snapshots`
 * measures a different quantity from the close's `units_shipped`: for July 2026 it totals **803
 * units** where Shoptics' shipped-units report totals **597**. Wiring it in would overstate
 * Amazon burn by ~35%. The close needs the SP-API *shipped-units* report Shoptics uses; until
 * that exists, `qb_amazon_sales_snapshots` is populated by the backfill.
 *
 * See docs/brain/libraries/qb-close-sync-sources.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAmplifierInventory } from "@/lib/integrations/amplifier";
import { fetchFbaInventoryByAsin } from "@/lib/amazon/fba-inventory";

export interface SyncResult {
  table: string;
  rows: number;
  note?: string;
}

/**
 * Bucket a UTC timestamp to the STORE-LOCAL calendar date.
 *
 * Load-bearing: Shoptics buckets a sale to the local date in Shopify's offset-bearing
 * `created_at`, but ShopCX stores `created_at` in UTC. Bucketing by the UTC date shifts evening
 * orders into the next day and will not reconcile — it is the whole of the 3-unit / 1-order gap
 * between ShopCX's order table and Shopify's own July report.
 */
export function storeLocalDate(utcIso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(utcIso),
  );
}

async function pageOrders(
  admin: SupabaseClient,
  workspaceId: string,
  start: string,
  end: string,
  internal: boolean,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  // ±1 day of UTC padding, filtered back down by store-local date — without it, orders near
  // midnight on the 1st and last are silently dropped.
  const from = new Date(`${start}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${end}T23:59:59Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  for (let offset = 0; ; offset += 1000) {
    let q = admin
      .from("orders")
      .select("id, order_number, source_name, financial_status, created_at, total_cents, line_items, payment_details, avalara_total_tax_cents, shipping_protection_amount_cents")
      .eq("workspace_id", workspaceId)
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString());
    q = internal ? q.is("shopify_order_id", null) : q.not("shopify_order_id", "is", null);
    const { data, error } = await q.range(offset, offset + 999);
    if (error) throw new Error(`orders: ${error.message}`);
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

const VOID = ["voided", "cancelled", "canceled"];
const COUNTED = ["paid", "partially_refunded", "refunded"];

/**
 * Shopify sales → `qb_shopify_sales_snapshots`, per `${product_id}-${variant_id}` per day.
 *
 * `units_sold` EXCLUDES fully-refunded orders (they land in `refund_units`) — matching the
 * Shoptics shape exactly, because the close reads `units_sold + refund_units` for burn and the
 * two columns must stay separable.
 */
export async function syncShopifySalesForClose(
  admin: SupabaseClient,
  workspaceId: string,
  start: string,
  end: string,
  timeZone = "America/Chicago",
): Promise<SyncResult> {
  const orders = await pageOrders(admin, workspaceId, start, end, false);

  // ⭐ Not every line carries `product_id` — 268 of July's lines (382 units) had only
  // `variant_id`. The accounting key is the COMPOSITE `${product_id}-${variant_id}`, so a line
  // missing the product half must be RESOLVED, never skipped: skipping cost 129 units against
  // Shopify's own report. Resolve shopify_variant_id → product_variants → products.
  const [variantRows, productRows] = await Promise.all([
    admin.from("product_variants").select("product_id, shopify_variant_id").eq("workspace_id", workspaceId),
    admin.from("products").select("id, shopify_product_id").eq("workspace_id", workspaceId),
  ]);
  const shopProductByInternal = new Map((productRows.data ?? []).map((p) => [p.id, String(p.shopify_product_id ?? "")]));
  const shopProductByVariant = new Map<string, string>();
  for (const v of variantRows.data ?? []) {
    if (!v.shopify_variant_id) continue;
    const sp = shopProductByInternal.get(v.product_id);
    if (sp) shopProductByVariant.set(String(v.shopify_variant_id), sp);
  }

  type Agg = { units: number; revenue: number; refundUnits: number; refundAmount: number; sku: string | null; name: string | null };
  const byKey = new Map<string, Agg>();
  let unresolvable = 0;

  for (const o of orders) {
    const status = String(o.financial_status ?? "").toLowerCase();
    if (VOID.includes(status) || !COUNTED.includes(status)) continue;
    const day = storeLocalDate(String(o.created_at), timeZone);
    if (day < start || day > end) continue; // discard the ±1-day padding
    const refunded = status === "refunded";
    for (const li of (o.line_items ?? []) as Record<string, unknown>[]) {
      const vid = li.variant_id;
      if (!vid) continue;
      const pid = li.product_id ?? shopProductByVariant.get(String(vid));
      if (!pid) { unresolvable += Number(li.quantity ?? 0); continue; }
      const key = `${day}|${pid}-${vid}`;
      const cur = byKey.get(key) ?? { units: 0, revenue: 0, refundUnits: 0, refundAmount: 0, sku: (li.sku as string) ?? null, name: (li.title as string) ?? null };
      const qty = Number(li.quantity ?? 0);
      const rev = (Number(li.price_cents ?? 0) * qty) / 100;
      if (refunded) { cur.refundUnits += qty; cur.refundAmount += rev; }
      else { cur.units += qty; cur.revenue += rev; }
      byKey.set(key, cur);
    }
  }

  const rows = [...byKey.entries()].map(([key, v]) => {
    const [sale_date, variant_id] = key.split("|");
    return {
      workspace_id: workspaceId, variant_id, sku: v.sku, product_name: v.name, sale_date,
      units_sold: v.units, revenue: Math.round(v.revenue * 100) / 100,
      refund_units: v.refundUnits, refund_amount: Math.round(v.refundAmount * 100) / 100,
      snapshot_taken_at: new Date().toISOString(),
    };
  });
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("qb_shopify_sales_snapshots").upsert(rows.slice(i, i + 500), { onConflict: "workspace_id,variant_id,sale_date" });
    if (error) throw new Error(`qb_shopify_sales_snapshots: ${error.message}`);
  }
  return {
    table: "qb_shopify_sales_snapshots",
    rows: rows.length,
    note: unresolvable ? `${unresolvable} unit(s) on lines with no resolvable product — investigate before closing` : undefined,
  };
}

/**
 * Internal (ShopCX-native) sales → `qb_internal_sales_snapshots`, per order line.
 *
 * ⭐ Renewal orders write inconsistent line items: `storefront` carries `sku`, while
 * `internal_subscription_renewal` carries none and a `variant_id` that is sometimes the internal
 * UUID and sometimes the SHOPIFY variant id. Resolution therefore tries sku → `product_variants.id`
 * → `product_variants.shopify_variant_id`. A line that resolves to nothing is still EMITTED (with
 * a null product) rather than skipped — dropping it breaks the JE's
 * `order_total == gross - discount + tax + shipping` identity by exactly its value, which is how
 * a single $48.27 line unbalanced the whole July journal entry.
 */
export async function syncInternalSalesForClose(
  admin: SupabaseClient,
  workspaceId: string,
  start: string,
  end: string,
  timeZone = "America/Chicago",
): Promise<SyncResult> {
  const [orders, variants, mappings, items] = await Promise.all([
    pageOrders(admin, workspaceId, start, end, true),
    admin.from("product_variants").select("id, shopify_variant_id, sku").eq("workspace_id", workspaceId),
    admin.from("qb_sku_mappings").select("external_id, product_id, unit_multiplier, active").eq("workspace_id", workspaceId).eq("source", "3pl"),
    admin.from("qb_items").select("id").eq("workspace_id", workspaceId),
  ]);
  const skuByVariant = new Map<string, string>();
  for (const v of variants.data ?? []) {
    if (!v.sku) continue;
    if (v.id) skuByVariant.set(String(v.id), String(v.sku));
    if (v.shopify_variant_id) skuByVariant.set(String(v.shopify_variant_id), String(v.sku));
  }
  const mapBySku = new Map((mappings.data ?? []).filter((m) => m.active).map((m) => [m.external_id, m]));
  const knownItems = new Set((items.data ?? []).map((i) => i.id));

  const rows: Record<string, unknown>[] = [];
  let unresolved = 0;
  for (const o of orders) {
    const status = String(o.financial_status ?? "").toLowerCase();
    if (VOID.includes(status)) continue;
    const day = storeLocalDate(String(o.created_at), timeZone);
    if (day < start || day > end) continue;

    const pd = (o.payment_details ?? {}) as Record<string, unknown>;
    const shipping = Number(pd.shipping_cents ?? 0) + Number(pd.protection_cents ?? o.shipping_protection_amount_cents ?? 0);
    const tax = Number(pd.tax_cents ?? o.avalara_total_tax_cents ?? 0);
    const discount = Number(pd.discount_cents ?? 0);

    let lineIndex = 0;
    for (const li of (o.line_items ?? []) as Record<string, unknown>[]) {
      const sku = String(li.sku ?? "").trim() || skuByVariant.get(String(li.variant_id ?? "")) || "";
      const mapping = sku ? mapBySku.get(sku) : undefined;
      const productId = mapping && knownItems.has(mapping.product_id) ? mapping.product_id : null;
      if (!productId) unresolved++;
      const qty = Number(li.quantity ?? 0);
      rows.push({
        workspace_id: workspaceId, order_id: o.id, order_number: o.order_number ?? null, line_index: lineIndex,
        sale_date: day, source_name: o.source_name ?? null, financial_status: o.financial_status ?? null,
        processor: (pd.gateway as string) ?? "unknown", sku: sku || null, variant_id: (li.variant_id as string) ?? null,
        product_id: productId,
        units: qty * Number(mapping?.unit_multiplier ?? 1),
        gross_cents: Math.round(Number(li.price_cents ?? li.unit_price_cents ?? 0) * qty),
        // order-level money on line_index 0 only, so an order is counted exactly once
        order_total_cents: lineIndex === 0 ? Number(o.total_cents ?? 0) : 0,
        discount_cents: lineIndex === 0 ? discount : 0,
        tax_cents: lineIndex === 0 ? tax : 0,
        shipping_cents: lineIndex === 0 ? shipping : 0,
        raw_payload: { source_name: o.source_name, payment_details: pd },
        snapshot_taken_at: new Date().toISOString(),
      });
      lineIndex++;
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("qb_internal_sales_snapshots").upsert(rows.slice(i, i + 500), { onConflict: "order_id,line_index" });
    if (error) throw new Error(`qb_internal_sales_snapshots: ${error.message}`);
  }
  return {
    table: "qb_internal_sales_snapshots",
    rows: rows.length,
    note: unresolved ? `${unresolved} line(s) could not resolve to a qb_item — emitted with a null product so the JE identity holds` : undefined,
  };
}

/**
 * FBA inventory → `qb_amazon_inventory_snapshots` for `snapshotDate`.
 *
 * ⭐ `quantity_transit` is written as `inbound + reserved`, matching the invariant the close
 * depends on and Shoptics' definition (inboundWorking + inboundShipped + inboundReceiving +
 * reserved — ShopCX's `inbound` already sums all three). Physical is then
 * `fulfillable + transit` ONLY; adding `reserved` or `inbound` again double-counts.
 */
export async function syncFbaInventoryForClose(
  admin: SupabaseClient,
  workspaceId: string,
  snapshotDate: string,
): Promise<SyncResult> {
  const { data: conns } = await admin
    .from("amazon_connections").select("id, marketplace_id").eq("workspace_id", workspaceId);
  if (!conns?.length) return { table: "qb_amazon_inventory_snapshots", rows: 0, note: "no amazon_connections for this workspace" };

  const rows: Record<string, unknown>[] = [];
  for (const c of conns) {
    const fba = await fetchFbaInventoryByAsin(c.id, c.marketplace_id);
    for (const f of fba) {
      rows.push({
        workspace_id: workspaceId, asin: f.asin, seller_sku: f.sellerSku,
        quantity_fulfillable: f.onHand, quantity_inbound: f.inbound, quantity_reserved: f.reserved,
        quantity_transit: f.inbound + f.reserved,
        snapshot_date: snapshotDate,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("qb_amazon_inventory_snapshots").upsert(rows.slice(i, i + 500), { onConflict: "workspace_id,asin,snapshot_date" });
    if (error) throw new Error(`qb_amazon_inventory_snapshots: ${error.message}`);
  }
  return { table: "qb_amazon_inventory_snapshots", rows: rows.length };
}

/**
 * 3PL inventory → `qb_tpl_inventory_snapshots` for `snapshotDate`.
 *
 * ⭐ Stores BOTH `quantity_on_hand` and `quantity_available`, and derives
 * `quantity_committed = on_hand − available` (the founder's identity: on_hand = available +
 * committed). The close reads **on_hand** — `available` excludes stock committed to unshipped
 * orders, which is still on the shelf and still ours at the cutoff.
 */
export async function syncTplInventoryForClose(
  admin: SupabaseClient,
  workspaceId: string,
  snapshotDate: string,
): Promise<SyncResult> {
  const inv = await fetchAmplifierInventory(workspaceId);
  const rows = inv.map((r) => ({
    workspace_id: workspaceId, sku: r.sku, name: null,
    quantity_on_hand: r.quantity_on_hand,
    quantity_available: r.quantity_available,
    quantity_committed: Math.max(0, r.quantity_on_hand - r.quantity_available),
    quantity_expected: 0,
    snapshot_date: snapshotDate,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("qb_tpl_inventory_snapshots").upsert(rows.slice(i, i + 500), { onConflict: "workspace_id,sku,snapshot_date" });
    if (error) throw new Error(`qb_tpl_inventory_snapshots: ${error.message}`);
  }
  return { table: "qb_tpl_inventory_snapshots", rows: rows.length };
}
