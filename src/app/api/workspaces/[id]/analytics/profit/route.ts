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
  const period = url.searchParams.get("period") || "this_month";

  const now = new Date();
  let startDate: string, endDate: string, daysInMonth: number, daysSoFar: number;

  if (period === "last_month") {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    startDate = first.toISOString().slice(0, 10);
    endDate = last.toISOString().slice(0, 10);
    daysInMonth = last.getDate();
    daysSoFar = daysInMonth; // complete
  } else {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    startDate = first.toISOString().slice(0, 10);
    endDate = now.toISOString().slice(0, 10);
    daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    daysSoFar = now.getDate();
  }

  // ── Shopify revenue (from daily snapshots) ──
  let shopifyRows: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const { data } = await admin.from("daily_order_snapshots")
      .select("recurring_revenue_cents, new_subscription_revenue_cents, one_time_revenue_cents, recurring_count, new_subscription_count, one_time_count")
      .eq("workspace_id", workspaceId)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate)
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    shopifyRows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  let shopRecurringRev = 0, shopNewSubRev = 0, shopOneTimeRev = 0;
  let shopRecurringCount = 0, shopNewSubCount = 0, shopOneTimeCount = 0;
  for (const _s of shopifyRows) {
    const s = _s as Record<string, number>;
    shopRecurringRev += s.recurring_revenue_cents || 0;
    shopNewSubRev += s.new_subscription_revenue_cents || 0;
    shopOneTimeRev += s.one_time_revenue_cents || 0;
    shopRecurringCount += s.recurring_count || 0;
    shopNewSubCount += s.new_subscription_count || 0;
    shopOneTimeCount += s.one_time_count || 0;
  }
  const shopTotalRev = shopRecurringRev + shopNewSubRev + shopOneTimeRev;

  // ── Amazon revenue ──
  let amzRows: Record<string, unknown>[] = [];
  offset = 0;
  while (true) {
    const { data } = await admin.from("daily_amazon_order_snapshots")
      .select("order_bucket, order_count, gross_revenue_cents")
      .eq("workspace_id", workspaceId)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate)
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    amzRows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  let amzRecurringRev = 0, amzOneTimeRev = 0, amzSnsRev = 0;
  let amzRecurringCount = 0, amzOneTimeCount = 0, amzSnsCount = 0;
  for (const _s of amzRows) {
    const s = _s as Record<string, unknown>;
    const rev = (s.gross_revenue_cents as number) || 0;
    const count = (s.order_count as number) || 0;
    if (s.order_bucket === "recurring") { amzRecurringRev += rev; amzRecurringCount += count; }
    else if (s.order_bucket === "sns_checkout") { amzSnsRev += rev; amzSnsCount += count; }
    else { amzOneTimeRev += rev; amzOneTimeCount += count; }
  }
  const amzTotalRev = amzRecurringRev + amzOneTimeRev + amzSnsRev;

  // ── Meta ad spend ──
  let metaSpend = 0;
  offset = 0;
  while (true) {
    const { data } = await admin.from("daily_meta_ad_spend")
      .select("spend_cents")
      .eq("workspace_id", workspaceId)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate)
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    for (const s of data) metaSpend += (s as { spend_cents: number }).spend_cents || 0;
    if (data.length < 1000) break;
    offset += 1000;
  }

  // ── Totals ──
  const totalRevenue = shopTotalRev + amzTotalRev;
  const totalOrders = shopRecurringCount + shopNewSubCount + shopOneTimeCount + amzRecurringCount + amzOneTimeCount + amzSnsCount;

  // ── Projections for incomplete months ──
  const isComplete = daysSoFar >= daysInMonth;
  const paceMultiplier = daysSoFar > 0 ? daysInMonth / daysSoFar : 1;

  const projectedRevenue = isComplete ? totalRevenue : Math.round(totalRevenue * paceMultiplier);
  const projectedOrders = isComplete ? totalOrders : Math.round(totalOrders * paceMultiplier);
  const projectedMetaSpend = isComplete ? metaSpend : Math.round(metaSpend * paceMultiplier);
  const projectedAmzRevenue = isComplete ? amzTotalRev : Math.round(amzTotalRev * paceMultiplier);

  return NextResponse.json({
    period,
    start_date: startDate,
    end_date: endDate,
    days_in_month: daysInMonth,
    days_so_far: daysSoFar,
    is_complete: isComplete,
    // Actuals
    actual: {
      shopify_revenue: shopTotalRev,
      shopify_recurring: shopRecurringRev,
      shopify_new_sub: shopNewSubRev,
      shopify_one_time: shopOneTimeRev,
      amazon_revenue: amzTotalRev,
      amazon_recurring: amzRecurringRev,
      amazon_one_time: amzOneTimeRev,
      amazon_sns: amzSnsRev,
      total_revenue: totalRevenue,
      total_orders: totalOrders,
      meta_spend: metaSpend,
    },
    // Projected (full month)
    projected: {
      total_revenue: projectedRevenue,
      total_orders: projectedOrders,
      meta_spend: projectedMetaSpend,
      amazon_revenue: projectedAmzRevenue,
    },
  });
}
