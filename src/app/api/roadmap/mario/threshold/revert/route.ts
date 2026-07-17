/**
 * POST /api/roadmap/mario/threshold/revert
 *   { workspace_id, from_event, to_event, pre_widen_sla_ms? }
 * Reverts a widened mario_thresholds row to its pre-widen sla_ms (or the seeded default when the
 * caller doesn't carry the prior value), clears last_widened_at + last_widened_reason, and writes
 * a `mario_threshold_reverted` director_activity row. mario-reactive-box-agent Phase 4.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient, getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { marioSeededDefaultSlaMs, revertMarioThreshold } from "@/lib/mario";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cookieStore = await cookies();
  const cookieWs = cookieStore.get("workspace_id")?.value;
  const body = (await request.json().catch(() => ({}))) as {
    workspace_id?: unknown;
    from_event?: unknown;
    to_event?: unknown;
    pre_widen_sla_ms?: unknown;
  };
  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : cookieWs ?? "";
  const from_event = typeof body.from_event === "string" ? body.from_event : "";
  const to_event = typeof body.to_event === "string" ? body.to_event : "";
  if (!workspaceId || !from_event || !to_event) {
    return NextResponse.json({ error: "workspace_id + from_event + to_event required" }, { status: 400 });
  }

  // Membership check — only workspace members can revert a threshold widen.
  const { data: mem } = await supabase
    .from("workspace_members")
    .select("workspace_id, role, display_name")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!mem) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const providedPreWiden =
    typeof body.pre_widen_sla_ms === "number" ? body.pre_widen_sla_ms : null;
  const seededDefault = marioSeededDefaultSlaMs(from_event, to_event);
  const preWidenSlaMs = providedPreWiden ?? seededDefault;
  if (preWidenSlaMs == null) {
    return NextResponse.json(
      { error: `no pre-widen sla_ms provided and no seeded default for ${from_event} → ${to_event}` },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const actor = (mem as { display_name?: string | null }).display_name ?? "human";
  const result = await revertMarioThreshold(admin, workspaceId, from_event, to_event, preWidenSlaMs, actor);
  if (!result.reverted) return NextResponse.json({ error: result.reason ?? "revert_failed" }, { status: 400 });
  return NextResponse.json({ reverted: true, pre_widen_sla_ms: preWidenSlaMs });
}
