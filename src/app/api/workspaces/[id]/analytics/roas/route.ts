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
  // For today: live query from orders table (snapshot cron runs at 1 AM)
  // For past days: daily_order_snapshots
  const shopifyRows: Record<string, unknown>[] = [];
  const today = new Date().toISOString().slice(0, 10);
  let offset = 0;

  // Snapshots for all days (today's Amazon/Meta updated every 5 min by cron)
  while (true) {
    const { data } = await admin
      .from("daily_order_snapshots")
      .select("snapshot_date, new_subscription_count, new_subscription_revenue_cents, one_time_count, one_time_revenue_cents, recurring_count")
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
      .select("source_name, total_cents, tags")
      .eq("workspace_id", workspaceId)
      .gte("created_at", utcStart)
      .lt("created_at", utcEnd);

    let newSubCount = 0, newSubRev = 0, oneTimeCount = 0, oneTimeRev = 0;
    for (const o of todayOrders || []) {
      if (o.source_name === "subscription_contract_checkout_one") continue;
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
  // Today's data kept fresh by 5-min cron (today-sync)
  const amazonRows: Record<string, unknown>[] = [];
  offset = 0;
  while (true) {
    const { data } = await admin
      .from("daily_amazon_order_snapshots")
      .select("snapshot_date, order_bucket, order_count, gross_revenue_cents")
      .eq("workspace_id", workspaceId)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate)
      .in("order_bucket", ["one_time", "sns_checkout"])
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
    shopify_new_sub_count: number;
    shopify_one_time_count: number;
    shopify_recurring_count: number;
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
    shopify_new_sub_count: 0, shopify_one_time_count: 0, shopify_recurring_count: 0,
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
    d.shopify_recurring_count += (s.recurring_count as number) || 0;
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
    shopify_recurring_count: acc.shopify_recurring_count + d.shopify_recurring_count,
    amazon_checkout_revenue: acc.amazon_checkout_revenue + d.amazon_checkout_revenue,
    amazon_one_time_revenue: acc.amazon_one_time_revenue + d.amazon_one_time_revenue,
    amazon_sns_checkout_revenue: acc.amazon_sns_checkout_revenue + d.amazon_sns_checkout_revenue,
    amazon_one_time_count: acc.amazon_one_time_count + d.amazon_one_time_count,
    amazon_sns_checkout_count: acc.amazon_sns_checkout_count + d.amazon_sns_checkout_count,
    meta_spend: acc.meta_spend + d.meta_spend,
  }), {
    shopify_checkout_revenue: 0, shopify_new_sub_revenue: 0, shopify_one_time_revenue: 0,
    shopify_new_sub_count: 0, shopify_one_time_count: 0, shopify_recurring_count: 0,
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
      shopify_recurring_count: totals.shopify_recurring_count,
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
