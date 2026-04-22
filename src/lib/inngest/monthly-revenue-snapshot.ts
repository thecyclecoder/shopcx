// Nightly cron: pre-compute monthly revenue snapshots from daily data
// Runs at 2 AM Central (7 AM UTC), rebuilds all months

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

export const monthlyRevenueSnapshot = inngest.createFunction(
  {
    id: "monthly-revenue-snapshot",
    retries: 1,
    triggers: [
      { cron: "0 7 * * *" }, // 2 AM Central
      { event: "revenue/rebuild-snapshots" }, // Manual trigger
    ],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // Get all workspaces
    const workspaces = await step.run("get-workspaces", async () => {
      const { data } = await admin.from("workspaces").select("id");
      return data || [];
    });

    for (const ws of workspaces) {
      await step.run(`compute-${ws.id}`, async () => {
        await computeMonthlySnapshots(ws.id);
      });
    }

    return { workspaces: workspaces.length };
  }
);

async function computeMonthlySnapshots(workspaceId: string) {
  const admin = createAdminClient();

  // ── Fetch all Shopify daily snapshots (paginated) ──
  const shopifyRows: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const { data } = await admin
      .from("daily_order_snapshots")
      .select("snapshot_date, recurring_count, recurring_revenue_cents, new_subscription_count, new_subscription_revenue_cents, one_time_count, one_time_revenue_cents, replacement_count, total_count, total_revenue_cents, shopify_mismatch")
      .eq("workspace_id", workspaceId)
      .order("snapshot_date", { ascending: true })
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    shopifyRows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  // ── Fetch all Amazon daily snapshots (paginated) ──
  const amazonRows: Record<string, unknown>[] = [];
  offset = 0;
  while (true) {
    const { data } = await admin
      .from("daily_amazon_order_snapshots")
      .select("snapshot_date, order_bucket, order_count, gross_revenue_cents")
      .eq("workspace_id", workspaceId)
      .order("snapshot_date", { ascending: true })
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    amazonRows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  // ── Aggregate Shopify by month ──
  interface ShopMonth {
    recurring_count: number; recurring_revenue_cents: number;
    new_subscription_count: number; new_subscription_revenue_cents: number;
    one_time_count: number; one_time_revenue_cents: number;
    replacement_count: number;
    total_count: number; total_revenue_cents: number;
    days: number; mismatches: number;
  }
  const shopMap = new Map<string, ShopMonth>();

  for (const _s of shopifyRows) {
    const s = _s as Record<string, number | string | boolean>;
    const monthKey = (s.snapshot_date as string).slice(0, 7);
    const existing = shopMap.get(monthKey) || {
      recurring_count: 0, recurring_revenue_cents: 0,
      new_subscription_count: 0, new_subscription_revenue_cents: 0,
      one_time_count: 0, one_time_revenue_cents: 0,
      replacement_count: 0, total_count: 0, total_revenue_cents: 0,
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
    shopMap.set(monthKey, existing);
  }

  // ── Aggregate Amazon by month ──
  interface AmzMonth {
    amz_recurring_count: number; amz_recurring_revenue_cents: number;
    amz_sns_checkout_count: number; amz_sns_checkout_revenue_cents: number;
    amz_one_time_count: number; amz_one_time_revenue_cents: number;
    amz_total_count: number; amz_total_revenue_cents: number;
  }
  const amzMap = new Map<string, AmzMonth>();

  for (const _s of amazonRows) {
    const s = _s as Record<string, unknown>;
    const monthKey = (s.snapshot_date as string).slice(0, 7);
    const existing = amzMap.get(monthKey) || {
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
    amzMap.set(monthKey, existing);
  }

  // ── Build monthly rows ──
  const allMonths = new Set([...shopMap.keys(), ...amzMap.keys()]);
  const sortedMonths = [...allMonths].sort();

  const upsertRows: Record<string, unknown>[] = [];

  for (let idx = 0; idx < sortedMonths.length; idx++) {
    const monthKey = sortedMonths[idx];
    const d = shopMap.get(monthKey) || {
      recurring_count: 0, recurring_revenue_cents: 0,
      new_subscription_count: 0, new_subscription_revenue_cents: 0,
      one_time_count: 0, one_time_revenue_cents: 0,
      replacement_count: 0, total_count: 0, total_revenue_cents: 0,
      days: 0, mismatches: 0,
    };
    const amz = amzMap.get(monthKey) || {
      amz_recurring_count: 0, amz_recurring_revenue_cents: 0,
      amz_sns_checkout_count: 0, amz_sns_checkout_revenue_cents: 0,
      amz_one_time_count: 0, amz_one_time_revenue_cents: 0,
      amz_total_count: 0, amz_total_revenue_cents: 0,
    };

    const mrr = d.recurring_revenue_cents + d.new_subscription_revenue_cents;

    // Shopify churn
    let churn_cents = 0, churn_pct = 0, prev_mrr = 0;
    if (idx > 0) {
      const prevData = shopMap.get(sortedMonths[idx - 1]);
      if (prevData) {
        prev_mrr = prevData.recurring_revenue_cents + prevData.new_subscription_revenue_cents;
        churn_cents = Math.max(0, prev_mrr - d.recurring_revenue_cents);
        churn_pct = prev_mrr > 0 ? (churn_cents / prev_mrr) * 100 : 0;
      }
    }

    const checkoutTotal = d.new_subscription_revenue_cents + d.one_time_revenue_cents;
    const subscription_rate = checkoutTotal > 0 ? (d.new_subscription_revenue_cents / checkoutTotal) * 100 : 0;

    const [y, m] = monthKey.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const is_complete = d.days >= daysInMonth;

    // Amazon churn
    const amz_mrr = amz.amz_recurring_revenue_cents + amz.amz_sns_checkout_revenue_cents;
    let amz_churn_cents = 0, amz_churn_pct = 0;
    if (idx > 0) {
      const prevAmz = amzMap.get(sortedMonths[idx - 1]);
      if (prevAmz) {
        const amz_prev = prevAmz.amz_recurring_revenue_cents + prevAmz.amz_sns_checkout_revenue_cents;
        amz_churn_cents = Math.max(0, amz_prev - amz.amz_recurring_revenue_cents);
        amz_churn_pct = amz_prev > 0 ? (amz_churn_cents / amz_prev) * 100 : 0;
      }
    }
    const amzCheckout = amz.amz_sns_checkout_revenue_cents + amz.amz_one_time_revenue_cents;
    const amz_sub_rate = amzCheckout > 0 ? (amz.amz_sns_checkout_revenue_cents / amzCheckout) * 100 : 0;

    upsertRows.push({
      workspace_id: workspaceId,
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
      ...amz,
      amz_mrr_cents: amz_mrr,
      amz_churn_cents,
      amz_churn_pct: Math.round(amz_churn_pct * 100) / 100,
      amz_subscription_rate: Math.round(amz_sub_rate * 100) / 100,
      computed_at: new Date().toISOString(),
    });
  }

  // Upsert in batches
  for (let i = 0; i < upsertRows.length; i += 50) {
    const batch = upsertRows.slice(i, i + 50);
    await admin.from("monthly_revenue_snapshots").upsert(batch, { onConflict: "workspace_id,month" });
  }

  console.log(`[Revenue Snapshot] ${workspaceId}: ${upsertRows.length} months computed`);
}
