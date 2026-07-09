/**
 * /api/tickets/analytics/selective-clarify — 7-day rolling selective-clarify rate.
 *
 * Phase 2 of docs/brain/specs/confidence-gated-problem-lockin-and-selective-clarify.md.
 * Powers the "Selective-clarify rate (target ~6%)" tile at /dashboard/tickets/analytics.
 * Read-only. Owner/admin/cs_manager only.
 *
 * Response: { window_days: 7, total: number, clarified: number, rate: number,
 *             by_outcome: Record<string, number>, target: 0.06 }
 *
 * `rate` sits near 0.06 (~6%) when the gate is calibrated. If it climbs toward 0.38
 * we're back in the blanket-clarify regime the parent goal rejects — that's the
 * signal to tighten IRREVERSIBLE_SET or bump clarify-below downward via policies.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

const ALLOWED_ROLES = ["owner", "admin", "cs_manager"];

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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
  if (!member || !ALLOWED_ROLES.includes(member.role)) {
    return NextResponse.json({ error: "Owner, admin, or CS manager role required" }, { status: 403 });
  }

  // Phase 1 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
  // Prior code fetched every ticket_resolution_events row in the 7-day window and
  // tallied verified_outcome in JS — PostgREST's 1000-row cap truncated the source
  // set on any busy workspace, so the "Selective-clarify rate (target ~6%)" tile
  // shrank as volume grew. Server-side GROUP BY now.
  const { data: rpcRows } = await admin.rpc("analytics_selective_clarify", {
    p_workspace: workspaceId,
    p_days: 7,
  });
  const agg = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as {
    total: number | string | null;
    confirmed: number | string | null;
    unbacked: number | string | null;
    drifted: number | string | null;
    clarified: number | string | null;
    unknown_count: number | string | null;
  } | null;
  const num = (v: number | string | null | undefined) =>
    v === null || v === undefined ? 0 : Number(v) || 0;
  const byOutcome: Record<string, number> = {
    confirmed: num(agg?.confirmed),
    unbacked: num(agg?.unbacked),
    drifted: num(agg?.drifted),
    clarified: num(agg?.clarified),
    unknown: num(agg?.unknown_count),
  };
  const total = num(agg?.total);
  const clarified = byOutcome.clarified;
  const rate = total > 0 ? clarified / total : 0;

  return NextResponse.json({
    window_days: 7,
    total,
    clarified,
    rate,
    by_outcome: byOutcome,
    target: 0.06,
  });
}
