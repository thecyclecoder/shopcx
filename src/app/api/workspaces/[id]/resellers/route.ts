import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET: list known_resellers for the workspace + summary of last
 * discovery run (from fraud_action_log entries with
 * action='reseller_discovered'). The Resellers UI page consumes this.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [{ data: resellers }, { data: lastDiscoveryEvents }] = await Promise.all([
    admin.from("known_resellers")
      .select("id, platform, amazon_seller_id, business_name, address1, address2, city, state, zip, country, status, source_asins, normalized_address, notes, discovered_at, last_seen_at, updated_at")
      .eq("workspace_id", workspaceId)
      .order("last_seen_at", { ascending: false }),
    admin.from("fraud_action_log")
      .select("created_at, metadata")
      .eq("workspace_id", workspaceId)
      .eq("action", "reseller_discovered")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  // Group the most recent discovery events into "runs" — anything
  // within ~30 minutes of each other is the same run.
  type Run = { ranAt: string; discovered: number };
  const runs: Run[] = [];
  let currentRun: { earliest: number; latest: number; count: number } | null = null;
  for (const ev of (lastDiscoveryEvents || []).slice().reverse()) {
    const t = new Date(ev.created_at).getTime();
    if (!currentRun || t - currentRun.latest > 30 * 60 * 1000) {
      if (currentRun) runs.push({ ranAt: new Date(currentRun.latest).toISOString(), discovered: currentRun.count });
      currentRun = { earliest: t, latest: t, count: 1 };
    } else {
      currentRun.latest = t;
      currentRun.count++;
    }
  }
  if (currentRun) runs.push({ ranAt: new Date(currentRun.latest).toISOString(), discovered: currentRun.count });
  runs.reverse();

  // Counts by status
  const statusCounts: Record<string, number> = { active: 0, dormant: 0, whitelisted: 0, unverified: 0 };
  for (const r of resellers || []) {
    if (r.status in statusCounts) statusCounts[r.status]++;
  }

  return NextResponse.json({
    resellers: resellers || [],
    statusCounts,
    recentRuns: runs.slice(0, 5),
  });
}
