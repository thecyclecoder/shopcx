/**
 * POST /api/roadmap/approve — owner approves/declines a build's gated action.
 *   { jobId, actionId, decision: "approve" | "decline" | "reject", notes? }
 * Marks the action; once no actions remain pending, flips the job to queued_resume so the
 * box worker executes the approved actions (with its prod creds) and resumes the build session.
 * `reject` + `notes` is the optimizer-hero-preview-gate reject-with-notes: it sends the owner's
 * notes back so the worker regenerates the hero candidate and re-surfaces it for preview.
 * See docs/brain/specs/build-approval-gates.md (Phase 3), docs/brain/specs/optimizer-hero-preview-gate.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { approveRoadmapAction } from "@/lib/roadmap-actions";

export async function POST(request: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown; actionId?: unknown; decision?: unknown; notes?: unknown };

  const result = await approveRoadmapAction(workspaceId, user.id, {
    jobId: typeof body.jobId === "string" ? body.jobId : "",
    actionId: typeof body.actionId === "string" ? body.actionId : "",
    decision: body.decision as "approve" | "decline" | "reject",
    notes: typeof body.notes === "string" ? body.notes : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ job: result.job });
}
