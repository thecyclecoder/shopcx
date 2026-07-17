import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bucketOrder } from "@/lib/order-bucketing";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const url = new URL(request.url);
  // Use Central time for "today" to match snapshot boundaries
  const centralToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const startDate = url.searchParams.get("start") || centralToday;
  const endDate = url.searchParams.get("end") || startDate;

  // ── Shopify checkout revenue (new subs + one-time, excludes recurring) ──
  // For today: live query from orders table (snapshot cron runs at 1 AM)
  // For past days: daily_order_snapshots
  const shopifyRows: Record<string, unknown>[] = [];
  const today = centralToday;
  let offset = 0;

  // Snapshots for all days (today's Amazon/Meta updated every 5 min by cron)
  while (true) {
    const { data } = await admin
      .from("daily_order_snapshots")
      .select("snapshot_date, new_subscription_count, new_subscription_revenue_cents, one_time_count, one_time_revenue_cents, recurring_count, recurring_revenue_cents")
      .eq("workspace_id", workspaceId)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate)
      .order("snapshot_date", { ascending: true })
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    shopifyRows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  // Live Shopify for today (Shopify snapshot runs at 1 AM, so today's is stale)
  if (endDate >= today && startDate <= today) {
    // Remove stale today snapshot if present
    const todayIdx = shopifyRows.findIndex(r => (r as Record<string, unknown>).snapshot_date === today);
    if (todayIdx >= 0) shopifyRows.splice(todayIdx, 1);

    const utcStart = today + "T05:00:00Z";
    const utcEnd = (() => { const d = new Date(today); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })() + "T05:00:00Z";

    const { data: todayOrders } = await admin
      .from("orders")
      .select("source_name, total_cents, tags, subscription_id")
      .eq("workspace_id", workspaceId)
      .gte("created_at", utcStart)
      .lt("created_at", utcEnd);

    // Bucket via the shared helper (same logic as the daily snapshot) so
    // internal storefront subs count as new_sub and internal renewals count
    // as recurring (excluded), instead of all landing in one_time.
    const { data: wsMapRow } = await admin
      .from("workspaces").select("order_source_mapping").eq("id", workspaceId).maybeSingle();
    const sourceMapping = (wsMapRow?.order_source_mapping || {}) as Record<string, string>;

    let newSubCount = 0, newSubRev = 0, oneTimeCount = 0, oneTimeRev = 0;
    let recurringCount = 0, recurringRev = 0;
    for (const o of todayOrders || []) {
      const bucket = bucketOrder(o, sourceMapping);
      if (bucket === "recurring") {
        recurringCount++;
        recurringRev += o.total_cents || 0;
      } else if (bucket === "new_sub") {
        newSubCount++;
        newSubRev += o.total_cents || 0;
      } else if (bucket === "one_time") {
        oneTimeCount++;
        oneTimeRev += o.total_cents || 0;
      }
      // replacement → excluded from ROAS (matches the snapshot's totals)
    }

    shopifyRows.push({
      snapshot_date: today,
      new_subscription_count: newSubCount,
      new_subscription_revenue_cents: newSubRev,
      one_time_count: oneTimeCount,
      one_time_revenue_cents: oneTimeRev,
      recurring_count: recurringCount,
      recurring_revenue_cents: recurringRev,
    });
  }

  // ── Amazon checkout revenue (all three buckets — recurring is surfaced
  //    separately as "not in ROAS" context). Today kept fresh by 5-min cron.
  const amazonRows: Record<string, unknown>[] = [];
  offset = 0;
  while (true) {
    const { data } = await admin
      .from("daily_amazon_order_snapshots")
      .select("snapshot_date, order_bucket, order_count, gross_revenue_cents")
      .eq("workspace_id", workspaceId)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate)
      .in("order_bucket", ["one_time", "sns_checkout", "recurring"])
      .order("snapshot_date", { ascending: true })
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    amazonRows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  // ── Meta ad spend (today kept fresh by 5-min cron) ──
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
    shopify_recurring_revenue: number;  // surfaced separately on cards
    shopify_new_sub_count: number;
    shopify_one_time_count: number;
    shopify_recurring_count: number;
    amazon_checkout_revenue: number;
    amazon_one_time_revenue: number;
    amazon_sns_checkout_revenue: number;
    amazon_recurring_revenue: number;   // surfaced separately on cards
    amazon_one_time_count: number;
    amazon_sns_checkout_count: number;
    amazon_recurring_count: number;
    meta_spend: number;
    // amazon_ad_spend: number; // future
  }

  const dayMap = new Map<string, DayData>();
  const emptyDay = (date: string): DayData => ({
    date,
    shopify_checkout_revenue: 0, shopify_new_sub_revenue: 0, shopify_one_time_revenue: 0,
    shopify_recurring_revenue: 0,
    shopify_new_sub_count: 0, shopify_one_time_count: 0, shopify_recurring_count: 0,
    amazon_checkout_revenue: 0, amazon_one_time_revenue: 0, amazon_sns_checkout_revenue: 0,
    amazon_recurring_revenue: 0,
    amazon_one_time_count: 0, amazon_sns_checkout_count: 0, amazon_recurring_count: 0,
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
    d.shopify_recurring_count += (s.recurring_count as number) || 0;
    d.shopify_recurring_revenue += (s.recurring_revenue_cents as number) || 0;
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
      d.amazon_checkout_revenue += rev;
    } else if (s.order_bucket === "recurring") {
      // SnS auto-renewals — NOT part of ROAS revenue, surfaced on the card
      // separately as "Recurring (not in ROAS)" context.
      d.amazon_recurring_revenue += rev;
      d.amazon_recurring_count += count;
    } else {
      d.amazon_one_time_revenue += rev;
      d.amazon_one_time_count += count;
      d.amazon_checkout_revenue += rev;
    }
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
    shopify_recurring_revenue: acc.shopify_recurring_revenue + d.shopify_recurring_revenue,
    shopify_new_sub_count: acc.shopify_new_sub_count + d.shopify_new_sub_count,
    shopify_one_time_count: acc.shopify_one_time_count + d.shopify_one_time_count,
    shopify_recurring_count: acc.shopify_recurring_count + d.shopify_recurring_count,
    amazon_checkout_revenue: acc.amazon_checkout_revenue + d.amazon_checkout_revenue,
    amazon_one_time_revenue: acc.amazon_one_time_revenue + d.amazon_one_time_revenue,
    amazon_sns_checkout_revenue: acc.amazon_sns_checkout_revenue + d.amazon_sns_checkout_revenue,
    amazon_recurring_revenue: acc.amazon_recurring_revenue + d.amazon_recurring_revenue,
    amazon_one_time_count: acc.amazon_one_time_count + d.amazon_one_time_count,
    amazon_sns_checkout_count: acc.amazon_sns_checkout_count + d.amazon_sns_checkout_count,
    amazon_recurring_count: acc.amazon_recurring_count + d.amazon_recurring_count,
    meta_spend: acc.meta_spend + d.meta_spend,
  }), {
    shopify_checkout_revenue: 0, shopify_new_sub_revenue: 0, shopify_one_time_revenue: 0,
    shopify_recurring_revenue: 0,
    shopify_new_sub_count: 0, shopify_one_time_count: 0, shopify_recurring_count: 0,
    amazon_checkout_revenue: 0, amazon_one_time_revenue: 0, amazon_sns_checkout_revenue: 0,
    amazon_recurring_revenue: 0,
    amazon_one_time_count: 0, amazon_sns_checkout_count: 0, amazon_recurring_count: 0,
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

  // ── Average churn from monthly revenue snapshots (for LTV calculation) ──
  // Average churn from ALL complete months (excludes current incomplete month)
  const { data: churnMonths } = await admin
    .from("monthly_revenue_snapshots")
    .select("churn_pct, amz_churn_pct")
    .eq("workspace_id", workspaceId)
    .eq("is_complete", true)
    .gt("churn_pct", 0)
    .order("month", { ascending: true });

  const shopifyAvgChurn = churnMonths?.length
    ? churnMonths.reduce((s, m) => s + Number(m.churn_pct), 0) / churnMonths.length / 100
    : 0;

  const amzChurnMonths = (churnMonths || []).filter(m => Number(m.amz_churn_pct) > 0);
  const amazonAvgChurn = amzChurnMonths.length
    ? amzChurnMonths.reduce((s, m) => s + Number(m.amz_churn_pct), 0) / amzChurnMonths.length / 100
    : 0;

  // ── LTV calculation ──
  // LTV = AOV × ((1 - sub_rate) + (sub_rate / monthly_churn))
  // Uses actual sub rate from selected period + average churn from historical data
  const shopifyOrderCount = totals.shopify_new_sub_count + totals.shopify_one_time_count;
  const shopifyAOV = shopifyOrderCount > 0 ? totals.shopify_checkout_revenue / shopifyOrderCount : 0;
  const shopifySubRateDec = shopifySubRate / 100;
  const shopifyLTV = shopifyAvgChurn > 0 && shopifyAOV > 0
    ? shopifyAOV * ((1 - shopifySubRateDec) + (shopifySubRateDec / shopifyAvgChurn))
    : shopifyAOV; // No churn data = just AOV

  const amazonOrderCount = totals.amazon_one_time_count + totals.amazon_sns_checkout_count;
  const amazonAOV = amazonOrderCount > 0 ? totals.amazon_checkout_revenue / amazonOrderCount : 0;
  const amazonSubRateDec = amazonSubRate / 100;
  const amazonLTV = amazonAvgChurn > 0 && amazonAOV > 0
    ? amazonAOV * ((1 - amazonSubRateDec) + (amazonSubRateDec / amazonAvgChurn))
    : amazonAOV;

  // Blended LTV (weighted by order count)
  const totalOrderCount = shopifyOrderCount + amazonOrderCount;
  const blendedLTV = totalOrderCount > 0
    ? (shopifyLTV * shopifyOrderCount + amazonLTV * amazonOrderCount) / totalOrderCount
    : 0;

  // ── Renewal-derived predicted sub-LTV (from the M3 storefront LTV proxy) ──
  // The ROAS LTV above is AOV×churn-derived; this surfaces the storefront optimizer's
  // renewal-survival-derived est-sub-LTV (the metric the dashboard previously lacked).
  // Best-effort: empty/null if storefront_ltv_metrics is absent (M3 not yet shipped here).
  const storefrontSubLtv = await buildStorefrontSubLtv(admin, workspaceId);

  return NextResponse.json({
    daily,
    totals,
    storefrontSubLtv,
    summary: {
      roas: Math.round(roas * 100) / 100,
      total_revenue_cents: totalRevenue,
      total_spend_cents: totalSpend,
      shopify_checkout_revenue: totals.shopify_checkout_revenue,
      shopify_new_sub_count: totals.shopify_new_sub_count,
      shopify_one_time_count: totals.shopify_one_time_count,
      shopify_recurring_revenue: totals.shopify_recurring_revenue,
      shopify_recurring_count: totals.shopify_recurring_count,
      amazon_checkout_revenue: totals.amazon_checkout_revenue,
      amazon_one_time_count: totals.amazon_one_time_count,
      amazon_sns_checkout_count: totals.amazon_sns_checkout_count,
      amazon_recurring_revenue: totals.amazon_recurring_revenue,
      amazon_recurring_count: totals.amazon_recurring_count,
      // For G&A allocation: total orders including recurring across all channels
      total_all_orders: totals.shopify_new_sub_count + totals.shopify_one_time_count + totals.shopify_recurring_count + totals.amazon_one_time_count + totals.amazon_sns_checkout_count,
      shopify_sub_rate: Math.round(shopifySubRate * 100) / 100,
      amazon_sub_rate: Math.round(amazonSubRate * 100) / 100,
      // LTV
      shopify_ltv_cents: Math.round(shopifyLTV),
      amazon_ltv_cents: Math.round(amazonLTV),
      blended_ltv_cents: Math.round(blendedLTV),
      shopify_aov_cents: Math.round(shopifyAOV),
      amazon_aov_cents: Math.round(amazonAOV),
      shopify_avg_churn_pct: Math.round(shopifyAvgChurn * 10000) / 100,
      amazon_avg_churn_pct: Math.round(amazonAvgChurn * 10000) / 100,
    },
    start: startDate,
    end: endDate,
  });
}

export interface StorefrontSubLtv {
  /** true once M3's slow loop has reconciled the proxy at least once. */
  calibrated: boolean;
  weights_version: number;
  snapshot_date: string | null;
  /** sub-conversion-weighted blend of per-product est-sub-LTV across the latest snapshot. */
  blended_est_sub_ltv_cents: number;
  by_product: Array<{
    product_id: string;
    title: string;
    est_sub_ltv_cents: number;
    sub_attach_rate: number;
    est_sub_ltv_sample_size: number;
  }>;
}

/**
 * Renewal-derived predicted sub-LTV per product from the latest [[storefront_ltv_metrics]]
 * snapshot — the est-sub-LTV the storefront optimizer (M3) computes from real subscription
 * renewal survival, surfaced on the ROAS dashboard alongside its AOV×churn LTV. est_sub_ltv
 * is product-level (identical across a product's cohorts), so we take it from the newest
 * snapshot per product and blend by sub-conversions. Best-effort — returns a null/empty
 * shape if the table is absent.
 */
async function buildStorefrontSubLtv(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
): Promise<StorefrontSubLtv> {
  const fallback: StorefrontSubLtv = { calibrated: false, weights_version: 1, snapshot_date: null, blended_est_sub_ltv_cents: 0, by_product: [] };
  try {
    const sinceIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: rows } = await admin
      .from("storefront_ltv_metrics")
      .select("product_id, snapshot_date, est_sub_ltv_cents, sub_attach_rate, sub_conversions, est_sub_ltv_sample_size, weights_version, calibrated")
      .eq("workspace_id", workspaceId)
      .gte("snapshot_date", sinceIso)
      .order("snapshot_date", { ascending: false });
    if (!rows?.length) return fallback;

    type Row = {
      product_id: string; snapshot_date: string; est_sub_ltv_cents: number; sub_attach_rate: number;
      sub_conversions: number; est_sub_ltv_sample_size: number; weights_version: number; calibrated: boolean;
    };
    // Newest snapshot per product (rows already newest-first).
    const latestByProduct = new Map<string, Row>();
    let latestSnapshot: string | null = null;
    for (const r of rows as Row[]) {
      if (!latestByProduct.has(r.product_id)) latestByProduct.set(r.product_id, r);
      if (!latestSnapshot || r.snapshot_date > latestSnapshot) latestSnapshot = r.snapshot_date;
    }

    const productIds = [...latestByProduct.keys()];
    const { data: productRows } = productIds.length
      ? await admin.from("products").select("id, title").in("id", productIds)
      : { data: [] as { id: string; title: string }[] };
    const titleById = new Map((productRows || []).map((p) => [p.id, p.title]));

    const byProduct = [...latestByProduct.values()].map((r) => ({
      product_id: r.product_id,
      title: titleById.get(r.product_id) || "(unknown)",
      est_sub_ltv_cents: r.est_sub_ltv_cents,
      sub_attach_rate: r.sub_attach_rate,
      est_sub_ltv_sample_size: r.est_sub_ltv_sample_size,
    }));

    // Blend weighted by sub-conversions; fall back to a simple mean when no conversions yet.
    let weightSum = 0;
    let weighted = 0;
    for (const r of latestByProduct.values()) {
      const w = Math.max(0, r.sub_conversions);
      weightSum += w;
      weighted += w * r.est_sub_ltv_cents;
    }
    const blended = weightSum > 0
      ? Math.round(weighted / weightSum)
      : byProduct.length
        ? Math.round(byProduct.reduce((s, p) => s + p.est_sub_ltv_cents, 0) / byProduct.length)
        : 0;

    const any = [...latestByProduct.values()][0];
    return {
      calibrated: !!any?.calibrated,
      weights_version: any?.weights_version ?? 1,
      snapshot_date: latestSnapshot,
      blended_est_sub_ltv_cents: blended,
      by_product: byProduct.sort((a, b) => b.est_sub_ltv_cents - a.est_sub_ltv_cents),
    };
  } catch {
    return fallback;
  }
}
