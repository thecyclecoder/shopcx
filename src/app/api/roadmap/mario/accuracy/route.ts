/**
 * GET /api/roadmap/mario/accuracy?workspace_id=<uuid>[&window_days=7]
 * Read-only accuracy stats + widened rows for the pipeline-health dashboard's MarioAccuracyCard.
 * mario-reactive-box-agent Phase 4.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient, getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readMarioAccuracy,
  readMarioWidenedThresholds,
  readMarioAccuracyAlarmPct,
} from "@/lib/mario";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cookieStore = await cookies();
  const cookieWs = cookieStore.get("workspace_id")?.value;
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspace_id") ?? cookieWs ?? "";
  if (!workspaceId) return NextResponse.json({ error: "workspace_id required" }, { status: 400 });

  // Confirm the caller is a member of the workspace (workspace_members RLS is service-role only).
  const { data: mem } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!mem) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const windowDays = Number.parseInt(url.searchParams.get("window_days") ?? "7", 10);
  const admin = createAdminClient();
  try {
    const stats = await readMarioAccuracy(admin, workspaceId, Number.isFinite(windowDays) ? windowDays : 7);
    const widened = await readMarioWidenedThresholds(admin, workspaceId);
    return NextResponse.json({ stats, widened, alarm_pct: readMarioAccuracyAlarmPct() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
