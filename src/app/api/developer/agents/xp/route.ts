/**
 * /api/developer/agents/xp — the derived per-director XP map
 * (directors-board-gamified spec, Phase 3).
 *
 * Owner-gated, read-only. Returns { xp: { [functionSlug]: DirectorXp } } — specs shipped · bugs fixed ·
 * goals escorted · streak, each computed from existing truth (agent_jobs / approval_decisions /
 * brain-roadmap / director_activity). Display-only — a gamified proxy, never an objective (operational-
 * rules § North star). Backs the XP card on each director's row in the Agents hub.
 *
 * See docs/brain/libraries/director-xp.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDirectorXp } from "@/lib/agents/director-xp";


export async function GET() {
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
    return NextResponse.json({ error: "Only the workspace owner can view director XP" }, { status: 403 });
  }

  const xp = await getDirectorXp(workspaceId);
  return NextResponse.json({ xp });
}
