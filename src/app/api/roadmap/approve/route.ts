/**
 * POST /api/roadmap/approve — owner approves/declines a build's gated action.
 *   { jobId, actionId, decision: "approve" | "decline" }
 * Marks the action; once no actions remain pending, flips the job to queued_resume so the
 * box worker executes the approved actions (with its prod creds) and resumes the build session.
 * See docs/brain/specs/build-approval-gates.md (Phase 3).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { approveRoadmapAction } from "@/lib/roadmap-actions";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown; actionId?: unknown; decision?: unknown };

  const result = await approveRoadmapAction(workspaceId, user.id, {
    jobId: typeof body.jobId === "string" ? body.jobId : "",
    actionId: typeof body.actionId === "string" ? body.actionId : "",
    decision: body.decision as "approve" | "decline",
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ job: result.job });
}
