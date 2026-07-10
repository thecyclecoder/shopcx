import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  INVESTORS_COOKIE_NAME,
  isInvestorRole,
  verifyInvestorSession,
} from "@/lib/investors/auth";

/**
 * GET /api/investors/pnl — the SAME P&L series the CFO Financials visual renders
 * (see /api/director/cfo/pnl), but gated by the magic-link `investors_session`
 * cookie instead of workspace-member auth. Returns the monthly qb_pnl_snapshots
 * rows (oldest→newest). See docs/brain/lifecycles/investors-area.md.
 *
 * The proxy leaves /api/investors/* un-gated (it would otherwise auth-redirect to
 * /login); this handler does its own cookie + role check.
 */
export async function GET() {
  const cookieStore = await cookies();
  const session = verifyInvestorSession(cookieStore.get(INVESTORS_COOKIE_NAME)?.value);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("id, workspace_id, comp_role")
    .eq("id", session.customerId)
    .maybeSingle();
  if (!customer || !isInvestorRole(customer.comp_role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { data, error } = await admin
    .from("qb_pnl_snapshots")
    .select(
      "period_month, currency, total_income, net_income, management_fees, adjusted_net_income, fixed_opex, digital_advertising, transaction_fees, refunds, chargebacks, discounts_coupons, inventory_adjustments",
    )
    .eq("workspace_id", customer.workspace_id)
    .order("period_month", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const rows = (data ?? []).map((r) => ({
    month: r.period_month as string,
    revenue: num(r.total_income),
    netProfit: num(r.net_income),
    mgmtFees: num(r.management_fees),
    netProfitWithAddbacks: num(r.adjusted_net_income),
    fixedOpex: num(r.fixed_opex),
    digitalAds: num(r.digital_advertising),
    transactionFees: num(r.transaction_fees),
    refunds: num(r.refunds),
    chargebacks: num(r.chargebacks),
    discountsCoupons: num(r.discounts_coupons),
    inventoryAdjustments: num(r.inventory_adjustments),
  }));

  return NextResponse.json({ currency: data?.[0]?.currency ?? "USD", rows });
}
