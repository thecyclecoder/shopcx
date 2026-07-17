/**
 * /api/developer/agents/sessions/[jobId] — the after-the-fact review surface for ONE box session
 * (box-session-transparency Phase 3).
 *
 * Owner-gated, read-only. Returns every preserved bit of the agent_jobs row a human needs to review
 * HOW the agent worked — not just its terminal status: kind + spec_slug + status + the persisted
 * session_checklist (the live plan it ticked through) + session_note (the last one-line note) +
 * log_tail (the raw terminal tail the worker writes on conclusion) + error + the matching
 * agent_action_grades row (if the grader scored it) — so the grader can cite the checklist and a
 * human can audit the call.
 *
 * Backs /dashboard/agents/sessions/[jobId]. Reachable from a per-agent panel row link
 * (AgentGradePanel → view session) and from the failed/paused lists on /dashboard/roadmap/box.
 * See docs/brain/specs/box-session-transparency.md Phase 3.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SessionChecklistItem } from "@/lib/agent-jobs";

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });

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
    return NextResponse.json({ error: "Only the workspace owner can view session reviews" }, { status: 403 });
  }

  const { data: job, error: jobErr } = await admin
    .from("agent_jobs")
    .select(
      "id, workspace_id, kind, spec_slug, status, pr_url, pr_number, created_at, updated_at, log_tail, error, session_checklist, session_note",
    )
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (jobErr || !job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: grade } = await admin
    .from("agent_action_grades")
    .select("grade, reasoning, graded_by, created_at")
    .eq("agent_job_id", jobId)
    .maybeSingle();

  const j = job as {
    id: string;
    kind: string;
    spec_slug: string | null;
    status: string;
    pr_url: string | null;
    pr_number: number | null;
    created_at: string;
    updated_at: string;
    log_tail: string | null;
    error: string | null;
    session_checklist: SessionChecklistItem[] | null;
    session_note: string | null;
  };

  return NextResponse.json({
    id: j.id,
    kind: j.kind,
    specSlug: j.spec_slug,
    status: j.status,
    prUrl: j.pr_url,
    prNumber: j.pr_number,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    logTail: j.log_tail,
    error: j.error,
    sessionChecklist: j.session_checklist ?? null,
    sessionNote: j.session_note ?? null,
    grade: grade
      ? {
          grade: (grade as { grade: number | null }).grade,
          reasoning: (grade as { reasoning: string | null }).reasoning,
          gradedBy: (grade as { graded_by: string }).graded_by,
          createdAt: (grade as { created_at: string }).created_at,
        }
      : null,
  });
}
