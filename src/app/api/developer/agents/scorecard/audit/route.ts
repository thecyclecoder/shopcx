/**
 * GET /api/developer/agents/scorecard/audit?metric=&cadence= — KPI drift verdict
 * ([[../../../../specs/devops-kpi-review-sdk-and-data-fix]] Phase 4).
 *
 * Owner-gated, read-only. Loads the latest persisted snapshot row for the requested
 * `(metric, cadence)` and re-runs the SAME `MetricDef.compute` from [[../../../../libraries/platform-scorecard]]
 * against the raw tables (via [[../../../../libraries/kpi-review]] `auditKpi`), returning a `KpiAuditReport`
 * — `{ snapshotValue, groundTruthValue, drift, driftPct, withinTolerance, snapshotDetail, groundTruthDetail, ... }`.
 *
 * Tiles on [[../../../../dashboard/agents]] scorecard page call this per metric after the snapshot loads
 * to render a drift subscript (green ✓ / amber `drift: +Y%` / red `DRIFT: snapshot=X · raw=Y`) — every
 * tile honest about whether the snapshot still matches the raw tables.
 *
 * Mirrors [[./route]] for auth (owner-gated, workspace_id from cookie).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditKpi } from "@/lib/agents/kpi-review";

type Cadence = "daily" | "weekly" | "monthly";
const CADENCES: Cadence[] = ["daily", "weekly", "monthly"];

export async function GET(req: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can audit the Platform scorecard" }, { status: 403 });
  }

  const url = new URL(req.url);
  const metric = url.searchParams.get("metric");
  const cadenceParam = url.searchParams.get("cadence");
  if (!metric) return NextResponse.json({ error: "metric is required" }, { status: 400 });
  if (!cadenceParam || !CADENCES.includes(cadenceParam as Cadence)) {
    return NextResponse.json({ error: "cadence must be daily|weekly|monthly" }, { status: 400 });
  }
  const cadence = cadenceParam as Cadence;

  const report = await auditKpi(workspaceId, metric, cadence);
  if (!report) return NextResponse.json({ report: null });
  return NextResponse.json({ report });
}
