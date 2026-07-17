/**
 * /api/developer/agents/agent-grades — a worker's grade rollup + recent graded actions (worker
 * observability, worker-grading-and-director-management Phase 3).
 *
 * Owner-gated, read-only. `GET ?kind=<agent_jobs.kind>` returns:
 *   - `rollup`: the standing performance score — last-10 average grade + the prior-window average + the
 *     drop (computeAgentRollup), the same signal the Director coaches on.
 *   - `recent`: the worker's recently-CONCLUDED agent_jobs (newest first) each with its grade (1–10 +
 *     reasoning) if graded yet — the live activity feed on the worker's profile page.
 *
 * Backs the rollup-grade card + the activity feed on /dashboard/agents/[role] for a worker seat.
 * See docs/brain/tables/agent_action_grades.md · docs/brain/libraries/agent-grader.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeAgentRollup, AGENT_RUBRICS, GRADEABLE_KINDS } from "@/lib/agents/agent-grader";
import type { SessionChecklistItem } from "@/lib/agent-jobs";


const TERMINAL = ["completed", "failed", "needs_attention"];

export async function GET(req: Request) {
  const kind = new URL(req.url).searchParams.get("kind");
  if (!kind) return NextResponse.json({ error: "Missing ?kind" }, { status: 400 });

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
    return NextResponse.json({ error: "Only the workspace owner can view worker grades" }, { status: 403 });
  }

  // Only a rubric-backed worker kind is graded — a non-worker kind has no rollup (return an empty shape).
  const gradeable = GRADEABLE_KINDS.includes(kind);
  const rollup = gradeable ? await computeAgentRollup(admin, workspaceId, kind) : { agentKind: kind, count: 0, average: null, priorAverage: null, drop: null };

  // Recent concluded actions of this worker + their grade (left join via a second lookup).
  // box-session-transparency Phase 3: include the preserved session_checklist + session_note so the
  // panel can render each row's plan/notes inline (the "how did it work" view, not just "what was its
  // status"). Each row links to /dashboard/agents/sessions/[jobId] for the full log_tail/error view.
  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, status, pr_url, created_at, session_checklist, session_note")
    .eq("workspace_id", workspaceId)
    .eq("kind", kind)
    .in("status", TERMINAL)
    .order("created_at", { ascending: false })
    .limit(20);
  const jobRows = (jobs || []) as Array<{
    id: string;
    spec_slug: string | null;
    status: string;
    pr_url: string | null;
    created_at: string;
    session_checklist: SessionChecklistItem[] | null;
    session_note: string | null;
  }>;

  const gradeByJob = new Map<string, { grade: number | null; reasoning: string | null; graded_by: string }>();
  if (jobRows.length) {
    const { data: grades } = await admin
      .from("agent_action_grades")
      .select("agent_job_id, grade, reasoning, graded_by")
      .in("agent_job_id", jobRows.map((j) => j.id));
    for (const g of (grades || []) as Array<{ agent_job_id: string; grade: number | null; reasoning: string | null; graded_by: string }>) {
      gradeByJob.set(g.agent_job_id, { grade: g.grade, reasoning: g.reasoning, graded_by: g.graded_by });
    }
  }

  const recent = jobRows.map((j) => {
    const g = gradeByJob.get(j.id);
    return {
      id: j.id,
      specSlug: j.spec_slug,
      status: j.status,
      prUrl: j.pr_url,
      createdAt: j.created_at,
      grade: g?.grade ?? null,
      reasoning: g?.reasoning ?? null,
      gradedBy: g?.graded_by ?? null,
      // box-session-transparency Phase 3 — the preserved live-plan + last note for the row's expand.
      sessionChecklist: j.session_checklist ?? null,
      sessionNote: j.session_note ?? null,
    };
  });

  return NextResponse.json({
    kind,
    rubric: AGENT_RUBRICS[kind]?.criteria ?? null,
    rollup,
    recent,
  });
}
