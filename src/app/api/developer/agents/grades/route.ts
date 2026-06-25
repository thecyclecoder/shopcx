/**
 * GET /api/developer/agents/grades — the Platform/DevOps Director grading report (director-loop-
 * grading spec, Phase 4 — the CEO's report contract for the director).
 *
 * Owner-gated, read-only. Returns per-dimension + per-leash-category grades with a trend, the
 * actionable leash-adjustment RECOMMENDATIONS (loosen/tighten), the recent grade rows (for the
 * override UI), the proposed calibration rules awaiting review, and the current Platform autonomy
 * envelope. The recommendations only RECOMMEND — the CEO disposes via the Autonomy toggle; the loop
 * never widens its own leash (operational-rules § North star). See
 * docs/brain/libraries/director-leash-recommendations.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeDirectorGradeReport } from "@/lib/agents/director-leash-recommendations";


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
    return NextResponse.json({ error: "Only the workspace owner can view director grades" }, { status: 403 });
  }

  const report = await computeDirectorGradeReport({ workspaceId, admin });
  return NextResponse.json(report);
}
