/**
 * GET /api/developer/agents — the Agents hub org chart (agents-hub-role-inboxes spec, Phase 1).
 *
 * Owner-gated, read-only. Returns the CEO → Directors → Workers tree read entirely
 * from the brain (`functions/*.md` + `goals/*.md` via brain-roadmap, worker lanes
 * from the Control Tower registry) — the data behind /dashboard/agents.
 *
 * See docs/brain/dashboard/agents.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrgChart } from "@/lib/agents/org-chart";


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
    return NextResponse.json({ error: "Only the workspace owner can view the Agents hub" }, { status: 403 });
  }

  const orgChart = await getOrgChart();
  return NextResponse.json(orgChart);
}
