import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const url = new URL(request.url);
  const startDate = url.searchParams.get("start") || new Date().toISOString().slice(0, 10);
  const endDate = url.searchParams.get("end") || startDate;

  // ── Shopify checkout revenue (new subs + one-time, excludes recurring) ──
  const shopifyRows: Record<string, unknown>[] = [];
  const today = new Date().toISOString().slice(0, 10);
  let offset = 0;

  // Use snapshots for past days
  const snapshotEnd = endDate >= today ? (() => {
    const d = new Date(today); d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })() : endDate;

  if (startDate <= snapshotEnd) {
    while (true) {
      const { data } = await admin
        .from("daily_order_snapshots")
        .select("snapshot_date, new_subscription_count, new_subscription_revenue_cents, one_time_count, one_time_revenue_cents")
        .eq("workspace_id", workspaceId)
        .gte("snapshot_date", startDate)
        .lte("snapshot_date", snapshotEnd)
        .order("snapshot_date", { ascending: true })
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      shopifyRows.push(...data);
      if (data.length < 1000) break;
      offset += 1000;
    }
  }

  // Live query for today if in range
  if (endDate >= today && startDate <= today) {
    const utcStart = today + "T05:00:00Z"; // Central midnight
    const utcEnd = (() => { const d = new Date(today); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })() + "T05:00:00Z";

    const { data: todayOrders } = await admin
      .from("orders")
      .select("source_name, total_cents, tags, line_items")
      .eq("workspace_id", workspaceId)
      .gte("created_at", utcStart)
      .lt("created_at", utcEnd);

    let newSubCount = 0, newSubRev = 0, oneTimeCount = 0, oneTimeRev = 0;
    for (const o of todayOrders || []) {
      if (o.source_name === "subscription_contract_checkout_one") continue; // recurring
      const tags = (o.tags || "").toLowerCase();
      if (tags.includes("first subscription")) {
        newSubCount++;
        newSubRev += o.total_cents || 0;
      } else {
        oneTimeCount++;
        oneTimeRev += o.total_cents || 0;
      }
    }

    shopifyRows.push({
      snapshot_date: today,
      new_subscription_count: newSubCount,
      new_subscription_revenue_cents: newSubRev,
      one_time_count: oneTimeCount,
      one_time_revenue_cents: oneTimeRev,
    });
  }

  // ── Amazon checkout revenue (one-time + sns_checkout, excludes recurring) ──
  const amazonRows: Record<string, unknown>[] = [];
  offset = 0;

  // Use snapshots for past days
  if (startDate <= snapshotEnd) {
    while (true) {
      const { data } = await admin
        .from("daily_amazon_order_snapshots")
        .select("snapshot_date, order_bucket, order_count, gross_revenue_cents")
        .eq("workspace_id", workspaceId)
        .gte("snapshot_date", startDate)
        .lte("snapshot_date", snapshotEnd)
        .in("order_bucket", ["one_time", "sns_checkout"])
        .order("snapshot_date", { ascending: true })
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      amazonRows.push(...data);
      if (data.length < 1000) break;
      offset += 1000;
    }
  }

  // Live Amazon query for today — pull fresh report from SP-API
  if (endDate >= today && startDate <= today) {
    const { data: amzConn } = await admin
      .from("amazon_connections")
      .select("id, marketplace_id, refresh_token_encrypted")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .maybeSingle();

    if (amzConn) {
      try {
        const { requestReport, pollReportStatus, downloadReport } = await import("@/lib/amazon/sync-orders");

        const reportId = await requestReport(amzConn.id, amzConn.marketplace_id, today + "T00:00:00Z", (() => { const d = new Date(today); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })() + "T00:00:00Z");

        let documentId: string | null = null;
        for (let i = 0; i < 30; i++) {
          const status = await pollReportStatus(amzConn.id, amzConn.marketplace_id, reportId);
          if (status.status === "DONE") { documentId = status.documentId; break; }
          if (status.status === "CANCELLED" || status.status === "FATAL") break;
          await new Promise(r => setTimeout(r, 3000));
        }

        if (documentId) {
          const tsv = await downloadReport(amzConn.id, amzConn.marketplace_id, documentId);
          const lines = tsv.split("\n");
          if (lines.length > 1) {
            const headers = lines[0].split("\t");
            const promoIdx = headers.indexOf("promotion-ids");
            const priceIdx = headers.indexOf("item-price");
            const statusIdx = headers.indexOf("order-status");
            const orderIdIdx = headers.indexOf("amazon-order-id");

            const buckets: Record<string, { orders: Set<string>; rev: number }> = {
              one_time: { orders: new Set(), rev: 0 },
              sns_checkout: { orders: new Set(), rev: 0 },
            };

            for (let j = 1; j < lines.length; j++) {
              const cols = lines[j].split("\t");
              if ((cols[statusIdx] || "").toLowerCase() === "cancelled") continue;
              const promo = cols[promoIdx] || "";
              const price = parseFloat(cols[priceIdx]) || 0;
              const orderId = cols[orderIdIdx] || "";

              // Skip recurring (SnS renewals)
              if (promo.includes("FBA Subscribe & Save Discount") || promo.includes("FBA Subscribe and Save Discount")) continue;

              const bucket = promo.includes("Subscribe and Save Promotion V2") ? "sns_checkout" : "one_time";
              buckets[bucket].orders.add(orderId);
              buckets[bucket].rev += price;
            }

            for (const [bucket, data] of Object.entries(buckets)) {
              if (data.orders.size > 0) {
                amazonRows.push({
                  snapshot_date: today,
                  order_bucket: bucket,
                  order_count: data.orders.size,
                  gross_revenue_cents: Math.round(data.rev * 100),
                });
              }
            }
          }
        }
      } catch (err) {
        console.error("[ROAS] Live Amazon query failed:", err);
      }
    }
  }

  // ── Meta ad spend ──
  const metaRows: Record<string, unknown>[] = [];
  offset = 0;
  while (true) {
    const { data } = await admin
      .from("daily_meta_ad_spend")
      .select("snapshot_date, spend_cents")
      .eq("workspace_id", workspaceId)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate)
      .order("snapshot_date", { ascending: true })
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    metaRows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  // ── Build daily breakdown ──
  interface DayData {
    date: string;
    shopify_checkout_revenue: number;
    shopify_new_sub_revenue: number;
    shopify_one_time_revenue: number;
    shopify_new_sub_count: number;
    shopify_one_time_count: number;
    amazon_checkout_revenue: number;
    amazon_one_time_revenue: number;
    amazon_sns_checkout_revenue: number;
    amazon_one_time_count: number;
    amazon_sns_checkout_count: number;
    meta_spend: number;
    // amazon_ad_spend: number; // future
  }

  const dayMap = new Map<string, DayData>();
  const emptyDay = (date: string): DayData => ({
    date,
    shopify_checkout_revenue: 0, shopify_new_sub_revenue: 0, shopify_one_time_revenue: 0,
    shopify_new_sub_count: 0, shopify_one_time_count: 0,
    amazon_checkout_revenue: 0, amazon_one_time_revenue: 0, amazon_sns_checkout_revenue: 0,
    amazon_one_time_count: 0, amazon_sns_checkout_count: 0,
    meta_spend: 0,
  });

  for (const _s of shopifyRows) {
    const s = _s as Record<string, number | string>;
    const date = s.snapshot_date as string;
    if (!dayMap.has(date)) dayMap.set(date, emptyDay(date));
    const d = dayMap.get(date)!;
    d.shopify_new_sub_revenue += s.new_subscription_revenue_cents as number;
    d.shopify_one_time_revenue += s.one_time_revenue_cents as number;
    d.shopify_new_sub_count += s.new_subscription_count as number;
    d.shopify_one_time_count += s.one_time_count as number;
    d.shopify_checkout_revenue += (s.new_subscription_revenue_cents as number) + (s.one_time_revenue_cents as number);
  }

  for (const _s of amazonRows) {
    const s = _s as Record<string, unknown>;
    const date = s.snapshot_date as string;
    if (!dayMap.has(date)) dayMap.set(date, emptyDay(date));
    const d = dayMap.get(date)!;
    const rev = (s.gross_revenue_cents as number) || 0;
    const count = (s.order_count as number) || 0;
    if (s.order_bucket === "sns_checkout") {
      d.amazon_sns_checkout_revenue += rev;
      d.amazon_sns_checkout_count += count;
    } else {
      d.amazon_one_time_revenue += rev;
      d.amazon_one_time_count += count;
    }
    d.amazon_checkout_revenue += rev;
  }

  for (const _s of metaRows) {
    const s = _s as Record<string, unknown>;
    const date = s.snapshot_date as string;
    if (!dayMap.has(date)) dayMap.set(date, emptyDay(date));
    dayMap.get(date)!.meta_spend += (s.spend_cents as number) || 0;
  }

  const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // ── Totals ──
  const totals = daily.reduce<Omit<DayData, "date">>((acc, d) => ({
    shopify_checkout_revenue: acc.shopify_checkout_revenue + d.shopify_checkout_revenue,
    shopify_new_sub_revenue: acc.shopify_new_sub_revenue + d.shopify_new_sub_revenue,
    shopify_one_time_revenue: acc.shopify_one_time_revenue + d.shopify_one_time_revenue,
    shopify_new_sub_count: acc.shopify_new_sub_count + d.shopify_new_sub_count,
    shopify_one_time_count: acc.shopify_one_time_count + d.shopify_one_time_count,
    amazon_checkout_revenue: acc.amazon_checkout_revenue + d.amazon_checkout_revenue,
    amazon_one_time_revenue: acc.amazon_one_time_revenue + d.amazon_one_time_revenue,
    amazon_sns_checkout_revenue: acc.amazon_sns_checkout_revenue + d.amazon_sns_checkout_revenue,
    amazon_one_time_count: acc.amazon_one_time_count + d.amazon_one_time_count,
    amazon_sns_checkout_count: acc.amazon_sns_checkout_count + d.amazon_sns_checkout_count,
    meta_spend: acc.meta_spend + d.meta_spend,
  }), {
    shopify_checkout_revenue: 0, shopify_new_sub_revenue: 0, shopify_one_time_revenue: 0,
    shopify_new_sub_count: 0, shopify_one_time_count: 0,
    amazon_checkout_revenue: 0, amazon_one_time_revenue: 0, amazon_sns_checkout_revenue: 0,
    amazon_one_time_count: 0, amazon_sns_checkout_count: 0,
    meta_spend: 0,
  });

  const totalRevenue = totals.shopify_checkout_revenue + totals.amazon_checkout_revenue;
  const totalSpend = totals.meta_spend; // + amazon_ad_spend future
  const roas = totalSpend > 0 ? totalRevenue / totalSpend : 0;

  // Subscription rates
  const shopifyCheckoutTotal = totals.shopify_new_sub_revenue + totals.shopify_one_time_revenue;
  const shopifySubRate = shopifyCheckoutTotal > 0 ? (totals.shopify_new_sub_revenue / shopifyCheckoutTotal) * 100 : 0;

  const amazonCheckoutTotal = totals.amazon_sns_checkout_revenue + totals.amazon_one_time_revenue;
  const amazonSubRate = amazonCheckoutTotal > 0 ? (totals.amazon_sns_checkout_revenue / amazonCheckoutTotal) * 100 : 0;

  return NextResponse.json({
    daily,
    totals,
    summary: {
      roas: Math.round(roas * 100) / 100,
      total_revenue_cents: totalRevenue,
      total_spend_cents: totalSpend,
      shopify_checkout_revenue: totals.shopify_checkout_revenue,
      shopify_new_sub_count: totals.shopify_new_sub_count,
      shopify_one_time_count: totals.shopify_one_time_count,
      amazon_checkout_revenue: totals.amazon_checkout_revenue,
      amazon_one_time_count: totals.amazon_one_time_count,
      amazon_sns_checkout_count: totals.amazon_sns_checkout_count,
      shopify_sub_rate: Math.round(shopifySubRate * 100) / 100,
      amazon_sub_rate: Math.round(amazonSubRate * 100) / 100,
    },
    start: startDate,
    end: endDate,
  });
}
