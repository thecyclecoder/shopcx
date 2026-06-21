// Amazon order sync: request report → poll → parse TSV → upsert daily snapshots

import { createAdminClient } from "@/lib/supabase/admin";
import { spApiRequest } from "./auth";

type Admin = ReturnType<typeof createAdminClient>;

interface AmazonOrderLine {
  orderId: string;
  sku: string;
  asin: string;
  quantity: number;
  price: number;
  date: string;
  promoIds: string;
  bucket: "recurring" | "sns_checkout" | "one_time";
}

function bucketOrder(promoIds: string): "recurring" | "sns_checkout" | "one_time" {
  // Amazon uses "&" in the actual report data, not "and"
  if (promoIds.includes("FBA Subscribe & Save Discount") || promoIds.includes("FBA Subscribe and Save Discount")) return "recurring";
  if (promoIds.includes("Subscribe and Save Promotion V2")) return "sns_checkout";
  return "one_time";
}

function parseTsvReport(tsv: string): AmazonOrderLine[] {
  const lines = tsv.split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t");
  const idx = (name: string) => headers.indexOf(name);

  const orderIdIdx = idx("amazon-order-id");
  const skuIdx = idx("sku");
  const asinIdx = idx("asin");
  const qtyIdx = idx("quantity");
  const priceIdx = idx("item-price");
  const dateIdx = idx("purchase-date");
  const promoIdx = idx("promotion-ids");
  const statusIdx = idx("order-status");

  const orders: AmazonOrderLine[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split("\t");

    // Include Shipped, Shipping, and Pending — only exclude Cancelled
    const status = cols[statusIdx]?.toLowerCase() ?? "";
    if (status === "cancelled") continue;

    const promoIds = cols[promoIdx] ?? "";
    orders.push({
      orderId: cols[orderIdIdx] ?? "",
      sku: cols[skuIdx] ?? "",
      asin: cols[asinIdx] ?? "",
      quantity: parseInt(cols[qtyIdx]) || 0,
      price: parseFloat(cols[priceIdx]) || 0,
      date: cols[dateIdx] ?? "",
      promoIds,
      bucket: bucketOrder(promoIds),
    });
  }

  return orders;
}

// ── Pack resolution (Phase 1) ──
// Resolve how many product units a single order line of an ASIN represents (1-pack vs 2-pack).
// Bands are PER-PRODUCT, not global: a product's 1-pack base = the lowest positive catalog price
// among that product's ASINs; ~2× base = 2-pack. Validated 2026-06-21 on live coffee order lines
// (1-pack $80–92, 2-pack $159–184 ≈ 2×). Provenance is recorded in pack_resolved_by for audit.

export type PackResolvedBy = "price" | "order_price" | "title" | "manual";

export interface PackResolution {
  pack_size: number | null;
  units_per_pack: number | null;
  pack_resolved_by: PackResolvedBy | null;
}

// Band a price (cents) against a per-product 1-pack base (cents). Windows are wide enough to absorb
// the real spread (1-pack ratio ~0.9–1.1, 2-pack ~1.7–2.3) without colliding.
function bandByPrice(priceCents: number, baseCents: number): number | null {
  if (!priceCents || !baseCents) return null;
  const ratio = priceCents / baseCents;
  if (ratio >= 0.6 && ratio <= 1.45) return 1;
  if (ratio >= 1.55 && ratio <= 2.5) return 2;
  return null;
}

// Last-resort: read pack + servings out of the listing title ("60/48/2 Bag Bundle" → 2-pack,
// "30/24" → 1-pack). units_per_pack is the first servings count found.
function parsePackFromTitle(title: string | null): { pack: number | null; units: number | null } {
  const t = (title || "").toLowerCase();
  if (!t) return { pack: null, units: null };
  const unitsMatch = t.match(/(\d{2,3})\s*(?:servings?|pods?|count|ct\b|cups?)/) || t.match(/\b(\d{2,3})\b/);
  const units = unitsMatch ? parseInt(unitsMatch[1], 10) : null;
  let pack: number | null = 1;
  if (/\b2[\s-]*(?:bag|pack|pk)\b|bundle|2\s*x\b|twin/.test(t)) pack = 2;
  return { pack, units };
}

// Resolve pack for one ASIN. opts.orderPriceCents is a real order line price, used as the fallback
// when the catalog price is $0/unknown (validated path for B0BV4WHWCX / B0BKR169VT).
export async function resolveAsinPack(
  admin: Admin,
  asin: string,
  opts: { orderPriceCents?: number; connectionId?: string } = {},
): Promise<PackResolution> {
  let q = admin
    .from("amazon_asins")
    .select("asin, title, product_id, current_price_cents, pack_size, units_per_pack, pack_resolved_by")
    .eq("asin", asin);
  if (opts.connectionId) q = q.eq("amazon_connection_id", opts.connectionId);
  const { data: row } = await q.maybeSingle();
  if (!row) return { pack_size: null, units_per_pack: null, pack_resolved_by: null };

  // Never override a human/manual mapping.
  if (row.pack_resolved_by === "manual") {
    return { pack_size: row.pack_size, units_per_pack: row.units_per_pack, pack_resolved_by: "manual" };
  }

  // Per-product 1-pack base = lowest positive catalog price among this product's ASINs.
  let baseCents = row.current_price_cents || 0;
  if (row.product_id) {
    const { data: siblings } = await admin
      .from("amazon_asins")
      .select("current_price_cents")
      .eq("product_id", row.product_id)
      .gt("current_price_cents", 0);
    const prices = (siblings || []).map((s) => s.current_price_cents as number).filter(Boolean);
    if (prices.length) baseCents = Math.min(...prices);
  }

  const titleParsed = parsePackFromTitle(row.title);

  // 1) Catalog price band.
  if (row.current_price_cents && baseCents) {
    const pack = bandByPrice(row.current_price_cents, baseCents);
    if (pack) return { pack_size: pack, units_per_pack: titleParsed.units, pack_resolved_by: "price" };
  }
  // 2) Real order line price band (catalog price missing/zero).
  if (opts.orderPriceCents && baseCents) {
    const pack = bandByPrice(opts.orderPriceCents, baseCents);
    if (pack) return { pack_size: pack, units_per_pack: titleParsed.units, pack_resolved_by: "order_price" };
  }
  // 3) Title servings as last resort.
  if (titleParsed.pack) {
    return { pack_size: titleParsed.pack, units_per_pack: titleParsed.units, pack_resolved_by: "title" };
  }
  return { pack_size: null, units_per_pack: null, pack_resolved_by: null };
}

// ── SP-API Report Lifecycle ──

export async function requestReport(
  connectionId: string,
  marketplaceId: string,
  startDate: string,
  endDate: string,
): Promise<string> {
  const res = await spApiRequest(connectionId, marketplaceId, "POST", "/reports/2021-06-30/reports", {
    reportType: "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL",
    marketplaceIds: [marketplaceId],
    dataStartTime: startDate,
    dataEndTime: endDate,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Report request failed: ${JSON.stringify(data)}`);
  return data.reportId;
}

export async function pollReportStatus(
  connectionId: string,
  marketplaceId: string,
  reportId: string,
): Promise<{ status: string; documentId: string | null }> {
  const res = await spApiRequest(connectionId, marketplaceId, "GET", `/reports/2021-06-30/reports/${reportId}`);
  const data = await res.json();
  return {
    status: data.processingStatus,
    documentId: data.reportDocumentId ?? null,
  };
}

export async function downloadReport(
  connectionId: string,
  marketplaceId: string,
  documentId: string,
): Promise<string> {
  const res = await spApiRequest(connectionId, marketplaceId, "GET", `/reports/2021-06-30/documents/${documentId}`);
  const docData = await res.json();
  if (!docData.url) throw new Error("No download URL in report document");

  const reportRes = await fetch(docData.url);
  if (!reportRes.ok) throw new Error(`Report download failed: ${reportRes.status}`);
  return await reportRes.text();
}

// ── Process TSV and Upsert Snapshots ──

export async function processOrderReport(params: {
  workspaceId: string;
  connectionId: string;
  reportTsv: string;
}): Promise<{ orderCount: number; snapshotCount: number; productSnapshotCount: number }> {
  const admin = createAdminClient();
  const orders = parseTsvReport(params.reportTsv);
  console.log(`[Amazon Sync] ${orders.length} line items parsed`);

  // Group by date + bucket
  const dailyBuckets = new Map<string, { gross: number; net: number }>();
  const ordersByDayBucket = new Map<string, Set<string>>();
  const allOrderIds = new Set<string>();

  // Per-product layer (Phase 2): SAME lines, also grouped by (date, asin, bucket). The aggregate
  // write below is left exactly as-is; this runs beside it. asin "" = no-asin sentinel (→ product_id null).
  type ProductBucket = { gross: number; net: number; units: number; orderIds: Set<string>; date: string; asin: string; bucket: string };
  const productBuckets = new Map<string, ProductBucket>();

  for (const order of orders) {
    if (!order.date || !order.orderId) continue;
    const dateStr = order.date.slice(0, 10);
    const key = `${dateStr}|${order.bucket}`;

    allOrderIds.add(order.orderId);

    if (!dailyBuckets.has(key)) dailyBuckets.set(key, { gross: 0, net: 0 });
    const stats = dailyBuckets.get(key)!;
    stats.gross += order.price;
    stats.net += order.price;

    if (!ordersByDayBucket.has(key)) ordersByDayBucket.set(key, new Set());
    ordersByDayBucket.get(key)!.add(order.orderId);

    const asin = order.asin || "";
    const pKey = `${dateStr}|${asin}|${order.bucket}`;
    if (!productBuckets.has(pKey)) {
      productBuckets.set(pKey, { gross: 0, net: 0, units: 0, orderIds: new Set(), date: dateStr, asin, bucket: order.bucket });
    }
    const pStats = productBuckets.get(pKey)!;
    pStats.gross += order.price;
    pStats.net += order.price;
    pStats.units += order.quantity;
    pStats.orderIds.add(order.orderId);
  }

  // Upsert daily snapshots
  let snapshotCount = 0;
  for (const [key, stats] of Array.from(dailyBuckets.entries())) {
    const [dateStr, bucket] = key.split("|");
    const orderCount = ordersByDayBucket.get(key)?.size ?? 0;

    await admin.from("daily_amazon_order_snapshots").upsert({
      workspace_id: params.workspaceId,
      amazon_connection_id: params.connectionId,
      snapshot_date: dateStr,
      order_bucket: bucket,
      order_count: orderCount,
      gross_revenue_cents: Math.round(stats.gross * 100),
      net_revenue_cents: Math.round(stats.net * 100),
    }, { onConflict: "amazon_connection_id,snapshot_date,order_bucket" });
    snapshotCount++;
  }

  // ── Per-product snapshots (Phase 2) ──
  // Resolve each line's asin → {product_id, pack_size} from amazon_asins (unmapped → product_id null).
  const asinList = Array.from(new Set(orders.map((o) => o.asin).filter(Boolean)));
  const asinMeta = new Map<string, { product_id: string | null; pack_size: number | null }>();
  for (let i = 0; i < asinList.length; i += 200) {
    const chunk = asinList.slice(i, i + 200);
    const { data: rows } = await admin
      .from("amazon_asins")
      .select("asin, product_id, pack_size")
      .eq("amazon_connection_id", params.connectionId)
      .in("asin", chunk);
    for (const r of rows || []) asinMeta.set(r.asin, { product_id: r.product_id, pack_size: r.pack_size });
  }

  let productSnapshotCount = 0;
  for (const pb of Array.from(productBuckets.values())) {
    const meta = asinMeta.get(pb.asin) || { product_id: null, pack_size: null };
    await admin.from("daily_amazon_product_snapshots").upsert({
      workspace_id: params.workspaceId,
      amazon_connection_id: params.connectionId,
      snapshot_date: pb.date,
      asin: pb.asin,
      product_id: meta.product_id,
      pack_size: meta.pack_size,
      order_bucket: pb.bucket,
      order_count: pb.orderIds.size,
      units: pb.units,
      gross_revenue_cents: Math.round(pb.gross * 100),
      net_revenue_cents: Math.round(pb.net * 100),
      updated_at: new Date().toISOString(),
    }, { onConflict: "amazon_connection_id,snapshot_date,asin,order_bucket" });
    productSnapshotCount++;
  }

  // Update sales channels
  const channelCounts = new Map<string, number>();
  for (const order of orders) {
    channelCounts.set(order.bucket, (channelCounts.get(order.bucket) || 0) + 1);
  }

  const CHANNEL_NAMES: Record<string, string> = {
    one_time: "One-Time Purchases",
    recurring: "Subscribe & Save (Renewals)",
    sns_checkout: "Subscribe & Save (New Signups)",
  };

  for (const [channelId, count] of Array.from(channelCounts.entries())) {
    await admin.from("amazon_sales_channels").upsert({
      workspace_id: params.workspaceId,
      amazon_connection_id: params.connectionId,
      channel_id: channelId,
      channel_name: CHANNEL_NAMES[channelId] || channelId,
      order_count: count,
    }, { onConflict: "amazon_connection_id,channel_id" });
  }

  // Update last sync time
  await admin.from("amazon_connections").update({
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", params.connectionId);

  return { orderCount: allOrderIds.size, snapshotCount, productSnapshotCount };
}
