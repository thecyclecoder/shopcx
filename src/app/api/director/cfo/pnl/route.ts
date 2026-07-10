import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

/**
 * GET /api/director/cfo/pnl — the CFO (Grace) P&L series for the Financials visual.
 * Owner/admin-gated. Returns the monthly snapshots (oldest→newest) from qb_pnl_snapshots:
 * revenue (total_income), booked net profit (net_income), management fees, and net profit with
 * addbacks (adjusted_net_income). See docs/brain/tables/qb_pnl_snapshots.md.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "no workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { data, error } = await admin
    .from("qb_pnl_snapshots")
    .select("period_month, currency, total_income, net_income, management_fees, adjusted_net_income")
    .eq("workspace_id", workspaceId)
    .order("period_month", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []).map((r) => ({
    month: r.period_month as string,
    revenue: r.total_income === null ? null : Number(r.total_income),
    netProfit: r.net_income === null ? null : Number(r.net_income),
    mgmtFees: r.management_fees === null ? null : Number(r.management_fees),
    netProfitWithAddbacks: r.adjusted_net_income === null ? null : Number(r.adjusted_net_income),
  }));

  return NextResponse.json({ currency: data?.[0]?.currency ?? "USD", rows });
}
