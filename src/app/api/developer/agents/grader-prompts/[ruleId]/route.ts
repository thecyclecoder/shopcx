/**
 * PATCH /api/developer/agents/grader-prompts/{ruleId} — approve / reject a director-grader
 * calibration rule (director-loop-grading spec, Phase 4). Only an 'approved' rule is injected into
 * the director-grader's system prompt (buildDirectorGraderSystemPrompt reads status='approved' only),
 * so this is the CEO's gate on the rubric. Mirrors the storefront grader-prompts approval route.
 *
 * Owner-gated. Body: { status?: 'proposed'|'approved'|'rejected'|'archived', title?, content?, sort_order? }
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const STATUSES = ["proposed", "approved", "rejected", "archived"];

export async function PATCH(req: Request, { params }: { params: Promise<{ ruleId: string }> }) {
  const { ruleId } = await params;

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
    return NextResponse.json({ error: "Only the workspace owner can review calibration rules" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body?.title === "string") updates.title = body.title.trim();
  if (typeof body?.content === "string") updates.content = body.content.trim();
  if (typeof body?.sort_order === "number") updates.sort_order = body.sort_order;
  if (typeof body?.status === "string") {
    if (!STATUSES.includes(body.status)) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    updates.status = body.status;
    updates.reviewed_at = new Date().toISOString();
    updates.reviewed_by = user.id;
  }

  const { data, error } = await admin
    .from("director_grader_prompts")
    .update(updates)
    .eq("id", ruleId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rule: data });
}
