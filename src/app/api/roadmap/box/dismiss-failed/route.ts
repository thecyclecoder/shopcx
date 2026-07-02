/**
 * POST /api/roadmap/box/dismiss-failed — owner clears a failed build/plan card on
 * /dashboard/roadmap/box without a manual DB edit (box-failed-build-supersede-and-dismiss Phase 2).
 *
 * The card gets stuck when a spurious failed attempt has no successful sibling (or the owner just
 * wants a ghost card gone — e.g., the underlying spec has already been folded manually). Instead
 * of asking the CEO to open psql, flip the target failed agent_jobs row to a terminal resolved
 * status (`status='completed'`, `error=null`, `log_tail` breadcrumb "dismissed by owner") so the
 * Phase-1 outcome-precedence selector treats it as a success and drops the slug from the failed
 * list on next refresh — the same effect as the manual clear done on 2026-07-02, now one-tap.
 *
 * Owner-gated (403 otherwise), mirroring /api/developer/agents/inbox/dismiss + /api/roadmap/box/drain.
 * The row is UPDATED, not deleted — grades/costs reference agent_job_id.
 *
 * Body: { jobId: string }. Only flips a build/plan row whose current status is `failed` in the
 * owner's workspace; anything else 400s so the button can't be used to force-complete an in-flight
 * or already-resolved job.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
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
    .select("role, display_name")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (member?.role !== "owner") return NextResponse.json({ error: "Owner only" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown };
  const jobId = typeof body.jobId === "string" ? body.jobId : null;
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const { data: job, error: fetchErr } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, kind, status")
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.kind !== "build" && job.kind !== "plan") {
    return NextResponse.json({ error: "Only build/plan jobs are dismissable here" }, { status: 400 });
  }
  if (job.status !== "failed") {
    return NextResponse.json({ error: `Job is not failed (status=${job.status})` }, { status: 400 });
  }

  const actor = member?.display_name ?? user.email ?? "owner";
  const breadcrumb = `dismissed by owner (${actor}) at ${new Date().toISOString()}`;
  const { error: updateErr } = await admin
    .from("agent_jobs")
    .update({
      status: "completed",
      error: null,
      log_tail: breadcrumb,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .eq("status", "failed");
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, jobId });
}
