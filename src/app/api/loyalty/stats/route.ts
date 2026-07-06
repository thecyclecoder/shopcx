import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Program-wide loyalty aggregate for the /dashboard/loyalty header cards.
// Replaces a 250-row client-side sample sum on the page (loyalty-list-stats-and-adjust-guard.md
// Phase 1) — the RPC sums over ALL loyalty_members for the workspace, so the numbers are correct
// regardless of member count and the average's denominator is the true total, not the sample size.
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspace_id");
  if (!workspaceId) return NextResponse.json({ error: "workspace_id required" }, { status: 400 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await admin.rpc("loyalty_program_stats", { p_workspace_id: workspaceId });
  if (error) {
    console.error("loyalty_program_stats error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const row = data?.[0] || { total_members: 0, total_points: 0, total_earned: 0, avg_points: 0 };
  return NextResponse.json({
    total_members: Number(row.total_members) || 0,
    total_points: Number(row.total_points) || 0,
    total_earned: Number(row.total_earned) || 0,
    avg_points: Number(row.avg_points) || 0,
  });
}
