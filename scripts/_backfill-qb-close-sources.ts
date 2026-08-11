/**
 * Ship-time backfill: populate ShopCX's qb_close SOURCE tables from the Shoptics DB.
 *
 * Shoptics remains the golden master until the cutover reconciles, so its per-day snapshots
 * are the origin of record for months already elapsed. Product identity crosses the boundary
 * via `quickbooks_id` (shoptics `products.quickbooks_id` ↔ ShopCX `qb_items.quickbooks_id`) —
 * never by name or row id.
 *
 * Idempotent: every write is an upsert on the table's natural key, so re-running converges.
 * Read-only against Shoptics. Range-paginated (PostgREST silently caps at 1000 rows).
 *
 * Usage: npx tsx scripts/_backfill-qb-close-sources.ts 2026-06 2026-07
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { readFileSync } from "fs";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MONTHS = process.argv.slice(2).length ? process.argv.slice(2) : ["2026-06", "2026-07"];

const env: Record<string, string> = {};
for (const l of readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SU = env.NEXT_PUBLIC_SUPABASE_URL;
const SK = env.SUPABASE_SERVICE_ROLE_KEY;

async function shoptics<T = Record<string, unknown>>(path: string): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const r = await fetch(`${SU}/rest/v1/${path}`, {
      headers: { apikey: SK, Authorization: `Bearer ${SK}`, Range: `${from}-${from + 999}` },
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    const b = (await r.json()) as T[];
    out.push(...b);
    if (b.length < 1000) break;
    from += 1000;
  }
  return out;
}

function monthBounds(m: string) {
  const [y, mo] = m.split("-").map(Number);
  const last = new Date(y, mo, 0).getDate();
  return { start: `${m}-01`, end: `${m}-${String(last).padStart(2, "0")}` };
}

async function main() {
  const admin = createAdminClient();

  // product identity bridge: shoptics products.id -> ShopCX qb_items.id, via quickbooks_id
  const sProducts = await shoptics<{ id: string; quickbooks_id: string | number }>("products?select=id,quickbooks_id");
  const { data: qbItems } = await admin.from("qb_items").select("id, quickbooks_id").eq("workspace_id", WS);
  const byQbId = new Map((qbItems ?? []).map((i) => [String(i.quickbooks_id), i.id]));
  const shopticsToShopcx = new Map<string, string>();
  let unbridged = 0;
  for (const p of sProducts) {
    const target = byQbId.get(String(p.quickbooks_id));
    if (target) shopticsToShopcx.set(p.id, target);
    else unbridged++;
  }
  console.log(`product bridge: ${shopticsToShopcx.size} mapped, ${unbridged} shoptics products with no ShopCX qb_item`);

  const upsert = async (table: string, rows: Record<string, unknown>[], onConflict: string) => {
    if (!rows.length) return console.log(`  ${table.padEnd(34)} 0 rows`);
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await admin.from(table).upsert(rows.slice(i, i + 500), { onConflict });
      if (error) throw new Error(`${table}: ${error.message}`);
    }
    console.log(`  ${table.padEnd(34)} ${rows.length} rows`);
  };

  for (const month of MONTHS) {
    const { start, end } = monthBounds(month);
    console.log(`\n=== ${month} (${start} .. ${end}) ===`);

    const amz = await shoptics(`amazon_sales_snapshots?select=*&sale_date=gte.${start}&sale_date=lte.${end}`);
    await upsert(
      "qb_amazon_sales_snapshots",
      amz.map((r) => ({
        workspace_id: WS, asin: r.asin, seller_sku: r.seller_sku, product_name: r.product_name,
        sale_date: r.sale_date, units_shipped: r.units_shipped ?? 0, revenue: r.revenue ?? 0,
        units_pending: r.units_pending ?? 0, units_cancelled: r.units_cancelled ?? 0,
        recurring_units: r.recurring_units ?? 0, recurring_revenue: r.recurring_revenue ?? 0,
        sns_checkout_units: r.sns_checkout_units ?? 0, sns_checkout_revenue: r.sns_checkout_revenue ?? 0,
        one_time_units: r.one_time_units ?? 0, one_time_revenue: r.one_time_revenue ?? 0,
        snapshot_taken_at: r.snapshot_taken_at,
      })),
      "workspace_id,asin,sale_date",
    );

    const shop = await shoptics(`shopify_sales_snapshots?select=*&sale_date=gte.${start}&sale_date=lte.${end}`);
    await upsert(
      "qb_shopify_sales_snapshots",
      shop.map((r) => ({
        workspace_id: WS, variant_id: r.variant_id, sku: r.sku, product_name: r.product_name,
        sale_date: r.sale_date, units_sold: r.units_sold ?? 0, revenue: r.revenue ?? 0,
        recurring_units: r.recurring_units ?? 0, recurring_revenue: r.recurring_revenue ?? 0,
        first_sub_units: r.first_sub_units ?? 0, first_sub_revenue: r.first_sub_revenue ?? 0,
        one_time_units: r.one_time_units ?? 0, one_time_revenue: r.one_time_revenue ?? 0,
        refund_units: r.refund_units ?? 0, refund_amount: r.refund_amount ?? 0,
        snapshot_taken_at: r.snapshot_taken_at,
      })),
      "workspace_id,variant_id,sale_date",
    );

    const intl = await shoptics(`internal_sales_snapshots?select=*&sale_date=gte.${start}&sale_date=lte.${end}`);
    await upsert(
      "qb_internal_sales_snapshots",
      intl.map((r) => ({
        workspace_id: WS, order_id: r.order_id, order_number: r.order_number, line_index: r.line_index ?? 0,
        sale_date: r.sale_date, source_name: r.source_name, financial_status: r.financial_status,
        processor: r.processor, sku: r.sku, variant_id: r.variant_id,
        product_id: r.product_id ? shopticsToShopcx.get(String(r.product_id)) ?? null : null,
        units: r.units ?? 0, gross_cents: r.gross_cents ?? 0, order_total_cents: r.order_total_cents ?? 0,
        discount_cents: r.discount_cents ?? 0, tax_cents: r.tax_cents ?? 0, shipping_cents: r.shipping_cents ?? 0,
        raw_payload: r.raw_payload, snapshot_taken_at: r.snapshot_taken_at,
      })),
      "order_id,line_index",
    );

    const fba = await shoptics(`amazon_inventory_snapshots?select=*&snapshot_date=gte.${start}&snapshot_date=lte.${end}`);
    await upsert(
      "qb_amazon_inventory_snapshots",
      fba.map((r) => ({
        workspace_id: WS, asin: r.asin, seller_sku: r.seller_sku, fn_sku: r.fn_sku,
        quantity_fulfillable: r.quantity_fulfillable ?? 0, quantity_inbound: r.quantity_inbound ?? 0,
        quantity_reserved: r.quantity_reserved ?? 0, quantity_transit: r.quantity_transit ?? 0,
        snapshot_date: r.snapshot_date,
      })),
      "workspace_id,asin,snapshot_date",
    );

    const tpl = await shoptics(`tpl_inventory_snapshots?select=*&snapshot_date=gte.${start}&snapshot_date=lte.${end}`);
    await upsert(
      "qb_tpl_inventory_snapshots",
      tpl.map((r) => ({
        workspace_id: WS, sku: r.sku, name: r.name,
        quantity_on_hand: r.quantity_on_hand ?? 0, quantity_available: r.quantity_available ?? 0,
        quantity_committed: r.quantity_committed ?? 0, quantity_expected: r.quantity_expected ?? 0,
        snapshot_date: r.snapshot_date,
      })),
      "workspace_id,sku,snapshot_date",
    );

    const proc = await shoptics(`payment_processor_summaries?select=*&closing_month=eq.${month}`);
    await upsert(
      "qb_payment_processor_summaries",
      proc.map((r) => ({
        workspace_id: WS, closing_month: r.closing_month, processor: r.processor,
        gross_sales: r.gross_sales ?? 0, processing_fees: r.processing_fees ?? 0, refunds: r.refunds ?? 0,
        chargebacks: r.chargebacks ?? 0, adjustments: r.adjustments ?? 0, net_deposits: r.net_deposits ?? 0,
        raw_payload: r.raw_payload, synced_at: r.synced_at,
      })),
      "workspace_id,closing_month,processor",
    );

    // QB book snapshots for this month (pre + post), from shoptics' generic inventory_snapshots
    const book = (await shoptics(`inventory_snapshots?select=*&source=eq.quickbooks`)).filter((r) => {
      const p = (r.raw_payload ?? {}) as Record<string, unknown>;
      return p.month === month && (p.snapshot_type === "month_end_pre" || p.snapshot_type === "month_end_post");
    });
    const bookRows = book
      .map((r) => {
        const p = (r.raw_payload ?? {}) as Record<string, unknown>;
        const pid = shopticsToShopcx.get(String(r.product_id));
        if (!pid) return null;
        return {
          workspace_id: WS, product_id: pid, source: "quickbooks", quantity: r.quantity ?? 0,
          snapshot_type: String(p.snapshot_type), closing_month: month,
          snapshot_at: r.snapshot_at, raw_payload: r.raw_payload,
        };
      })
      .filter(Boolean) as Record<string, unknown>[];
    // no natural key on this table (a month can be re-snapshotted) — clear the slice first
    await admin.from("qb_book_inventory_snapshots").delete().eq("workspace_id", WS).eq("closing_month", month);
    if (bookRows.length) {
      const { error } = await admin.from("qb_book_inventory_snapshots").insert(bookRows);
      if (error) throw new Error(`qb_book_inventory_snapshots: ${error.message}`);
    }
    console.log(`  ${"qb_book_inventory_snapshots".padEnd(34)} ${bookRows.length} rows (of ${book.length} shoptics rows)`);
  }

  console.log("\n✓ backfill complete");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
