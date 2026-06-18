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
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentJob, PendingAction } from "@/lib/agent-jobs";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can approve a build action" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown; actionId?: unknown; decision?: unknown };
  if (typeof body.jobId !== "string" || typeof body.actionId !== "string" || (body.decision !== "approve" && body.decision !== "decline")) {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  const { data: jobRow } = await admin
    .from("agent_jobs").select("*").eq("id", body.jobId).eq("workspace_id", workspaceId).maybeSingle();
  const job = jobRow as AgentJob | null;
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  if (job.status !== "needs_approval") return NextResponse.json({ error: "job is not awaiting approval" }, { status: 409 });

  const actions: PendingAction[] = (job.pending_actions || []).map((a) =>
    a.id === body.actionId ? { ...a, status: body.decision === "approve" ? "approved" : "declined" } : a,
  );
  if (!actions.some((a) => a.id === body.actionId)) return NextResponse.json({ error: "action not found" }, { status: 404 });

  // Resume only once every action has a decision; otherwise keep waiting on the rest.
  const stillPending = actions.some((a) => a.status === "pending");
  const patch: Record<string, unknown> = { pending_actions: actions, updated_at: new Date().toISOString() };
  if (!stillPending) patch.status = "queued_resume";

  const { data: updated, error } = await admin.from("agent_jobs").update(patch).eq("id", body.jobId).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: updated as AgentJob });
}
