/**
 * GET /api/developer/agents/rollups — every agent's standing grade rollup in one shot, so the Agents
 * roster can show everyone's score at a glance (worker-grading-and-director-management Phase 3).
 *
 * Owner-gated, read-only. Returns `{ rollups: { [agent_kind]: { average, count, drop } } }` — the last-10
 * average grade + drop per rubric-backed agent kind (computeAgentRollup). See docs/brain/libraries/agent-grader.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeAgentRollup, GRADEABLE_KINDS } from "@/lib/agents/agent-grader";


export async function GET() {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }

  const rollups: Record<string, { average: number | null; count: number; drop: number | null }> = {};
  for (const kind of GRADEABLE_KINDS) {
    const r = await computeAgentRollup(admin, workspaceId, kind);
    rollups[kind] = { average: r.average, count: r.count, drop: r.drop };
  }
  return NextResponse.json({ rollups });
}
