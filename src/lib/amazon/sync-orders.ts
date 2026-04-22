// Amazon order sync: request report → poll → parse TSV → upsert daily snapshots

import { createAdminClient } from "@/lib/supabase/admin";
import { spApiRequest } from "./auth";

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
  if (promoIds.includes("FBA Subscribe and Save Discount")) return "recurring";
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
}): Promise<{ orderCount: number; snapshotCount: number }> {
  const admin = createAdminClient();
  const orders = parseTsvReport(params.reportTsv);
  console.log(`[Amazon Sync] ${orders.length} line items parsed`);

  // Group by date + bucket
  const dailyBuckets = new Map<string, { gross: number; net: number }>();
  const ordersByDayBucket = new Map<string, Set<string>>();
  const allOrderIds = new Set<string>();

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

  return { orderCount: allOrderIds.size, snapshotCount };
}
