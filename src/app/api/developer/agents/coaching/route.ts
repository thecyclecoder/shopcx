/**
 * /api/developer/agents/coaching — a worker's coaching history (worker-coaching-loop spec, Phase 1).
 *
 * Owner-gated, read-only. `GET ?kind=<agent_kind>` returns { history: AgentCoachingEntry[] } — the
 * director→worker messages that worker has received (the old→new instruction diff, the triggering
 * pattern, the attempt count, the post-coaching re-check status), newest-first. Backs the "Coaching
 * history" section on the worker's profile page (/dashboard/agents/[role]).
 *
 * See docs/brain/tables/agent_coaching_log.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAgentCoachingHistory } from "@/lib/agents/agent-instructions";


export async function GET(req: Request) {
  const kind = new URL(req.url).searchParams.get("kind");
  if (!kind) return NextResponse.json({ error: "Missing ?kind" }, { status: 400 });

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
    return NextResponse.json({ error: "Only the workspace owner can view coaching history" }, { status: 403 });
  }

  const history = await getAgentCoachingHistory(admin, workspaceId, kind);
  return NextResponse.json({ history });
}
