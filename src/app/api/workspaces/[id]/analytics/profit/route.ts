import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  centralToday,
  estimateCurrentMonthProfit,
  estimateUnclosedMonthProfit,
  getClosedMonthProfit,
  monthStart,
  lastClosedMonths,
  unclosedMonths,
} from "@/lib/profit-estimate";

/**
 * GET /api/workspaces/[id]/analytics/profit?period=this_month|last_month|YYYY-MM
 *
 * Closed months return QuickBooks ACTUALS from qb_pnl_snapshots; the in-progress
 * month returns a calibrated estimate, and so does an elapsed month whose
 * snapshot hasn't landed yet (books close ~the 15th). See src/lib/profit-estimate.ts and
 * docs/brain/libraries/profit-estimate.md.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const today = centralToday();
  const period = new URL(request.url).searchParams.get("period") || "this_month";

  // Resolve the requested period to a period_month (first-of-month).
  let periodMonth: string;
  if (period === "this_month") {
    periodMonth = monthStart(today);
  } else if (period === "last_month") {
    periodMonth = lastClosedMonths(1, today)[0];
  } else if (/^\d{4}-\d{2}$/.test(period)) {
    periodMonth = `${period}-01`;
  } else {
    return NextResponse.json({ error: "bad period" }, { status: 400 });
  }

  try {
    // Which months are actually selectable (have a snapshot), newest first.
    const { data: available } = await admin
      .from("qb_pnl_snapshots")
      .select("period_month")
      .eq("workspace_id", workspaceId)
      .order("period_month", { ascending: false })
      .limit(24);
    const availableMonths = (available ?? []).map((r) => String(r.period_month).slice(0, 7));
    // Elapsed months not yet snapshotted — estimated until their books close.
    const estimatedMonths = unclosedMonths(availableMonths, today);

    const isCurrentMonth = periodMonth === monthStart(today);
    const isUnclosed = estimatedMonths.includes(periodMonth);
    const result = isCurrentMonth
      ? await estimateCurrentMonthProfit(admin, workspaceId, today)
      : isUnclosed
        ? await estimateUnclosedMonthProfit(admin, workspaceId, periodMonth)
        : await getClosedMonthProfit(admin, workspaceId, periodMonth);

    if (!result) {
      return NextResponse.json(
        {
          error: "no_snapshot",
          message: `No QuickBooks P&L snapshot for ${periodMonth.slice(0, 7)}. Run the snapshot backfill.`,
          period_month: periodMonth,
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ...result,
      available_months: availableMonths,
      estimated_months: estimatedMonths.map((m) => m.slice(0, 7)),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
