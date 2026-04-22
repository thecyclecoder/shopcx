import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);
  const startDate = url.searchParams.get("start");
  const endDate = url.searchParams.get("end");
  const mode = url.searchParams.get("mode") || "daily"; // "daily" | "monthly"

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (mode === "monthly") {
    // Return monthly aggregates — last 16 months for trendline + YoY comparison
    const monthsBack = parseInt(url.searchParams.get("months") || "16");
    const now = new Date();
    const earliest = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
    const earliestStr = earliest.toISOString().slice(0, 10);

    // Paginate Shopify snapshots (Supabase 1000-row limit)
    const snapshots: Record<string, unknown>[] = [];
    {
      let offset = 0;
      while (true) {
        const { data: page } = await admin
          .from("daily_order_snapshots")
          .select("snapshot_date, recurring_count, recurring_revenue_cents, new_subscription_count, new_subscription_revenue_cents, one_time_count, one_time_revenue_cents, replacement_count, total_count, total_revenue_cents, shopify_mismatch")
          .eq("workspace_id", workspaceId)
          .gte("snapshot_date", earliestStr)
          .order("snapshot_date", { ascending: true })
          .range(offset, offset + 999);
        if (!page || page.length === 0) break;
        snapshots.push(...page);
        if (page.length < 1000) break;
        offset += 1000;
      }
    }

    // Aggregate by month
    const monthMap = new Map<string, {
      recurring_count: number; recurring_revenue_cents: number;
      new_subscription_count: number; new_subscription_revenue_cents: number;
      one_time_count: number; one_time_revenue_cents: number;
      replacement_count: number;
      total_count: number; total_revenue_cents: number;
      days: number; mismatches: number;
    }>();

    for (const _s of snapshots) {
      const s = _s as Record<string, number | string | boolean>;
      const monthKey = (s.snapshot_date as string).slice(0, 7); // YYYY-MM
      const existing = monthMap.get(monthKey) || {
        recurring_count: 0, recurring_revenue_cents: 0,
        new_subscription_count: 0, new_subscription_revenue_cents: 0,
        one_time_count: 0, one_time_revenue_cents: 0,
        replacement_count: 0,
        total_count: 0, total_revenue_cents: 0,
        days: 0, mismatches: 0,
      };
      existing.recurring_count += s.recurring_count as number;
      existing.recurring_revenue_cents += s.recurring_revenue_cents as number;
      existing.new_subscription_count += s.new_subscription_count as number;
      existing.new_subscription_revenue_cents += s.new_subscription_revenue_cents as number;
      existing.one_time_count += s.one_time_count as number;
      existing.one_time_revenue_cents += s.one_time_revenue_cents as number;
      existing.replacement_count += s.replacement_count as number;
      existing.total_count += s.total_count as number;
      existing.total_revenue_cents += s.total_revenue_cents as number;
      existing.days++;
      if (s.shopify_mismatch) existing.mismatches++;
      monthMap.set(monthKey, existing);
    }

    // ── Amazon data (paginated) ──
    const amazonSnapshots: Record<string, unknown>[] = [];
    {
      let offset = 0;
      while (true) {
        const { data: page } = await admin
          .from("daily_amazon_order_snapshots")
          .select("snapshot_date, order_bucket, order_count, gross_revenue_cents")
          .eq("workspace_id", workspaceId)
          .gte("snapshot_date", earliestStr)
          .order("snapshot_date", { ascending: true })
          .range(offset, offset + 999);
        if (!page || page.length === 0) break;
        amazonSnapshots.push(...page);
        if (page.length < 1000) break;
        offset += 1000;
      }
    }

    // Aggregate Amazon by month
    const amzMonthMap = new Map<string, {
      amz_recurring_count: number; amz_recurring_revenue_cents: number;
      amz_sns_checkout_count: number; amz_sns_checkout_revenue_cents: number;
      amz_one_time_count: number; amz_one_time_revenue_cents: number;
      amz_total_count: number; amz_total_revenue_cents: number;
    }>();

    for (const _s of amazonSnapshots) {
      const s = _s as Record<string, unknown>;
      const monthKey = (s.snapshot_date as string).slice(0, 7);
      const existing = amzMonthMap.get(monthKey) || {
        amz_recurring_count: 0, amz_recurring_revenue_cents: 0,
        amz_sns_checkout_count: 0, amz_sns_checkout_revenue_cents: 0,
        amz_one_time_count: 0, amz_one_time_revenue_cents: 0,
        amz_total_count: 0, amz_total_revenue_cents: 0,
      };
      const rev = (s.gross_revenue_cents as number) || 0;
      const count = (s.order_count as number) || 0;
      if (s.order_bucket === "recurring") {
        existing.amz_recurring_count += count;
        existing.amz_recurring_revenue_cents += rev;
      } else if (s.order_bucket === "sns_checkout") {
        existing.amz_sns_checkout_count += count;
        existing.amz_sns_checkout_revenue_cents += rev;
      } else {
        existing.amz_one_time_count += count;
        existing.amz_one_time_revenue_cents += rev;
      }
      existing.amz_total_count += count;
      existing.amz_total_revenue_cents += rev;
      amzMonthMap.set(monthKey, existing);
    }

    // Build monthly array with calculated values
    const sortedMonths = [...monthMap.keys()].sort();
    const months = sortedMonths.map((monthKey, idx) => {
      const d = monthMap.get(monthKey)!;
      const mrr = d.recurring_revenue_cents + d.new_subscription_revenue_cents;

      // Churn = previous month MRR - this month recurring
      let churn_cents = 0;
      let churn_pct = 0;
      let prev_mrr = 0;
      if (idx > 0) {
        const prevData = monthMap.get(sortedMonths[idx - 1]);
        if (prevData) {
          prev_mrr = prevData.recurring_revenue_cents + prevData.new_subscription_revenue_cents;
          churn_cents = Math.max(0, prev_mrr - d.recurring_revenue_cents);
          churn_pct = prev_mrr > 0 ? (churn_cents / prev_mrr) * 100 : 0;
        }
      }

      // Subscription rate = new sub rev / (new sub rev + one-time rev)
      const checkoutTotal = d.new_subscription_revenue_cents + d.one_time_revenue_cents;
      const subscription_rate = checkoutTotal > 0
        ? (d.new_subscription_revenue_cents / checkoutTotal) * 100
        : 0;

      // Is this month complete?
      const [y, m] = monthKey.split("-").map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      const is_complete = d.days >= daysInMonth;

      // Amazon data for this month
      const amz = amzMonthMap.get(monthKey) || {
        amz_recurring_count: 0, amz_recurring_revenue_cents: 0,
        amz_sns_checkout_count: 0, amz_sns_checkout_revenue_cents: 0,
        amz_one_time_count: 0, amz_one_time_revenue_cents: 0,
        amz_total_count: 0, amz_total_revenue_cents: 0,
      };

      // Amazon MRR = recurring + new SnS
      const amz_mrr = amz.amz_recurring_revenue_cents + amz.amz_sns_checkout_revenue_cents;

      // Amazon churn
      let amz_churn_cents = 0;
      let amz_churn_pct = 0;
      let amz_prev_mrr = 0;
      if (idx > 0) {
        const prevAmz = amzMonthMap.get(sortedMonths[idx - 1]);
        if (prevAmz) {
          amz_prev_mrr = prevAmz.amz_recurring_revenue_cents + prevAmz.amz_sns_checkout_revenue_cents;
          amz_churn_cents = Math.max(0, amz_prev_mrr - amz.amz_recurring_revenue_cents);
          amz_churn_pct = amz_prev_mrr > 0 ? (amz_churn_cents / amz_prev_mrr) * 100 : 0;
        }
      }

      // Amazon sub rate = new SnS / (new SnS + one-time)
      const amzCheckoutTotal = amz.amz_sns_checkout_revenue_cents + amz.amz_one_time_revenue_cents;
      const amz_subscription_rate = amzCheckoutTotal > 0
        ? (amz.amz_sns_checkout_revenue_cents / amzCheckoutTotal) * 100
        : 0;

      return {
        month: monthKey,
        ...d,
        mrr_cents: mrr,
        churn_cents,
        churn_pct: Math.round(churn_pct * 100) / 100,
        prev_mrr_cents: prev_mrr,
        net_mrr_cents: mrr - churn_cents,
        subscription_rate: Math.round(subscription_rate * 100) / 100,
        is_complete,
        days_in_month: daysInMonth,
        // Amazon
        ...amz,
        amz_mrr_cents: amz_mrr,
        amz_churn_cents,
        amz_churn_pct: Math.round(amz_churn_pct * 100) / 100,
        amz_subscription_rate: Math.round(amz_subscription_rate * 100) / 100,
      };
    });

    return NextResponse.json({ months });
  }

  // Daily mode
  if (!startDate || !endDate) {
    return NextResponse.json({ error: "start and end date required" }, { status: 400 });
  }

  const { data: snapshots } = await admin
    .from("daily_order_snapshots")
    .select("*")
    .eq("workspace_id", workspaceId)
    .gte("snapshot_date", startDate)
    .lte("snapshot_date", endDate)
    .order("snapshot_date", { ascending: true });

  return NextResponse.json({ snapshots: snapshots || [] });
}
