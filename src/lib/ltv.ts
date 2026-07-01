/**
 * Canonical lifetime-orders / LTV multipliers — the SINGLE source of truth for
 * the churn-derived subscription lifetime used across analytics.
 *
 * Mirrors the ROAS margin calculator (dashboard/analytics/roas): a subscriber's
 * expected lifetime orders = 1 / monthly_churn (geometric series — `1/churn` is
 * the expected number of monthly renewals before they cancel), a one-time buyer
 * = 1 order. The margin calc's blended "avg lifetime orders" is exactly
 * `(1-subRate)·1 + subRate·(1/churn)` — i.e. the per-order average of the two
 * multipliers below.
 *
 * The multiplier is NOT a constant — it tracks real retention. Lower churn ⇒ a
 * sub is worth more lifetime orders ⇒ LTV rises. Couples Growth (front of funnel)
 * to Retention (churn). Always recompute it live; never bake in a number.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Expected lifetime orders for ONE subscription = 1 / monthly_churn (≈4.5–5.3). */
export function subLifetimeOrders(monthlyChurn: number): number {
  return monthlyChurn > 0 ? 1 / monthlyChurn : 1;
}

/** Blended avg lifetime orders across subs + one-times — the ROAS card's "Avg
 *  lifetime orders" number. `subRate` is COUNT-based (subs / total orders). */
export function blendedLifetimeOrders(subRate: number, monthlyChurn: number): number {
  return monthlyChurn > 0 ? (1 - subRate) + subRate / monthlyChurn : 1;
}

export interface ChurnBasis {
  /** monthly churn as a decimal (0.19 = 19%) */
  monthly_churn: number;
  /** sub lifetime-orders multiplier (1/churn) actually applied */
  sub_lifetime_orders: number;
  months_used: number;
  /** human-readable window, surfaced for auditability */
  window: string;
}

/**
 * Average monthly churn from `monthly_revenue_snapshots`. By DEFAULT a TRAILING
 * window (last `trailingMonths` complete months) so the number stays RESPONSIVE
 * to recent retention work — the ROAS margin calc uses all-history (stable but
 * laggy: a recent retention win is diluted across every month). Pass
 * `trailingMonths: null` for the all-history (ROAS-parity) figure.
 */
export async function getMonthlyChurn(args: {
  admin: Admin;
  workspaceId: string;
  trailingMonths?: number | null;
}): Promise<ChurnBasis> {
  const { admin, workspaceId } = args;
  const trailing = args.trailingMonths === undefined ? 6 : args.trailingMonths;
  const { data } = await admin
    .from("monthly_revenue_snapshots")
    .select("month, churn_pct")
    .eq("workspace_id", workspaceId)
    .eq("is_complete", true)
    .gt("churn_pct", 0)
    .order("month", { ascending: false });
  const rows = data || [];
  const used = trailing && trailing > 0 ? rows.slice(0, trailing) : rows;
  const churn = used.length ? used.reduce((s, r) => s + Number(r.churn_pct), 0) / used.length / 100 : 0;
  return {
    monthly_churn: churn,
    sub_lifetime_orders: subLifetimeOrders(churn),
    months_used: used.length,
    window: trailing && trailing > 0 ? `trailing ${trailing}mo` : "all-history",
  };
}
