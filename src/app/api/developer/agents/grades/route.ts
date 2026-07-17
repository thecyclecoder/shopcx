/**
 * GET /api/developer/agents/grades — the Director grading report (director-loop-grading spec,
 * Phase 4 — the CEO's report contract for the directors; growth-adopt-meta-iteration-engine
 * Phase 2 — adds the Growth slice next to Platform).
 *
 * Owner-gated, read-only. Returns the Platform Director's full report at the top level
 * (back-compat for the existing DirectorGradePanel + DirectorGrades tab) AND a `growth` slice with
 * the Growth Director's report shape, so a per-director Director-grades tab can render both
 * without a second route. The recommendations only RECOMMEND — the CEO disposes via the Autonomy
 * toggle; the loop never widens its own leash (operational-rules § North star). See
 * docs/brain/libraries/director-leash-recommendations.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeDirectorGradeReport } from "@/lib/agents/director-leash-recommendations";
import { PLATFORM } from "@/lib/agents/platform-director";
import { GROWTH } from "@/lib/agents/growth-director";


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
    return NextResponse.json({ error: "Only the workspace owner can view director grades" }, { status: 403 });
  }

  // Compute BOTH director slices in parallel — the Growth slice is what
  // growth-adopt-meta-iteration-engine Phase 2 surfaces to the tab. Platform stays at the top level
  // so the existing UI keeps working unchanged; Growth is added as a sibling slice.
  const [platform, growth] = await Promise.all([
    computeDirectorGradeReport({ workspaceId, admin, directorFunction: PLATFORM }),
    computeDirectorGradeReport({ workspaceId, admin, directorFunction: GROWTH }),
  ]);
  return NextResponse.json({ ...platform, growth });
}
