/**
 * GET /api/developer/control-tower — the Control Tower snapshot (control-tower spec, Phase 1).
 *
 * Owner-gated, read-only. Returns the green/amber/red status of every monitored loop
 * (box worker liveness, cron freshness, agent-kind stuck jobs) plus per-loop last-ran /
 * last-produced / recent history / open alerts — the data behind /dashboard/developer/control-tower.
 * Evaluation is shared with the control-tower-monitor cron (src/lib/control-tower/monitor.ts);
 * this endpoint never mutates (no alert open/resolve, no paging).
 *
 * See docs/brain/dashboard/control-tower.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildControlTowerSnapshot } from "@/lib/control-tower/monitor";
import { buildErrorFeedSnapshot } from "@/lib/control-tower/error-feed";
import { getControlTowerDbPanels } from "@/lib/control-tower/snapshot";


export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
    return NextResponse.json({ error: "Only the workspace owner can view the Control Tower" }, { status: 403 });
  }

  // cut-internal-egress-pooler-and-spec-rpcs Phase 3: the six raw-SELECT panels (db-health / repairs
  // / director-dismissed / coverage-register / spec-drift / claude-health) are now consolidated by
  // the `public.control_tower_snapshot(uuid)` RPC into ONE round trip via `getControlTowerDbPanels`.
  // The heavier `buildControlTowerSnapshot` (per-loop iteration + rollups) + `buildErrorFeedSnapshot`
  // (per-source dedup) stay as their own concurrent reads — their fan-outs need their own derivation.
  const [snapshot, errorFeed, dbPanels] = await Promise.all([
    buildControlTowerSnapshot(admin),
    buildErrorFeedSnapshot(admin),
    getControlTowerDbPanels(admin, workspaceId),
  ]);

  // Fold the error panels into the header health count so an unconfigured panel (amber
  // "not configured") is NEVER counted as healthy — the self-honest count of the spec.
  const counts = { ...snapshot.counts };
  for (const p of errorFeed.panels) counts[p.color]++;

  return NextResponse.json({
    ...snapshot,
    counts,
    errorFeed,
    specDrift:         dbPanels.specDrift,
    repairs:           dbPanels.repairs,
    directorDismissed: dbPanels.directorDismissed,
    dbHealth:          dbPanels.dbHealth,
    coverageRegister:  dbPanels.coverageRegister,
    claudeHealth:      dbPanels.claudeHealth,
  });
}
