/**
 * POST /api/developer/control-tower/coverage-register — the owner's decision on a surfaced
 * coverage-register proposal (coverage-auto-register-agent spec, Phase 1). The agent PROPOSES the
 * inferred MONITORED_LOOPS entry for an unregistered cron loop; the OWNER finalizes here.
 *
 *   { jobId, action: 'register' } → land the entry: approve the action (decision='register') + flip the
 *                                   job to queued_resume; the box's runCoverageRegisterJob materializes
 *                                   the register fix spec to main + queues its build (the owner-gate).
 *   { jobId, action: 'exempt' }   → intentionally-unmonitored: approve (decision='exempt') + queued_resume;
 *                                   the box materializes the INTENTIONALLY_UNMONITORED_CRONS exemption
 *                                   spec + queues its build. The audit stops flagging the loop.
 *   { jobId, action: 'dismiss' }  → not now: decline + complete the job directly (no box round-trip).
 *
 * Owner-gated. The agent NEVER silently edits registry.ts — the build is queued only on this tap.
 *
 * See docs/brain/specs/coverage-auto-register-agent.md · docs/brain/libraries/coverage-register-agent.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
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
    return NextResponse.json({ error: "Only the workspace owner can act on a coverage-register item" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown; action?: unknown };
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const action =
    body.action === "register" || body.action === "exempt" || body.action === "dismiss" ? body.action : null;
  if (!jobId || !action) {
    return NextResponse.json({ error: "jobId and action ('register'|'exempt'|'dismiss') are required" }, { status: 400 });
  }

  const { data: job } = await admin
    .from("agent_jobs")
    .select("id, kind, status, spec_slug, pending_actions")
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .eq("kind", "coverage-register")
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "Coverage-register job not found" }, { status: 404 });
  if (job.status !== "needs_approval") {
    return NextResponse.json({ error: `Coverage-register job is ${job.status}, not actionable` }, { status: 409 });
  }

  const actions = Array.isArray(job.pending_actions) ? (job.pending_actions as Array<Record<string, unknown>>) : [];

  if (action === "dismiss") {
    // Dismiss completes directly — no prod creds needed. The gap may re-surface on a later audit unless
    // it's later registered/exempted; that's the intended "not now" behavior.
    const next = actions.map((a) => (a.type === "coverage_register" ? { ...a, status: "declined" } : a));
    const { error } = await admin
      .from("agent_jobs")
      .update({ status: "completed", pending_actions: next, error: "dismissed by owner", updated_at: new Date().toISOString() })
      .eq("id", jobId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, action });
  }

  // register | exempt: approve the action with the owner's decision + flip to queued_resume so the box
  // re-claims it on the coverage-register lane and materializes the chosen fix spec + queues its build.
  const decision = action; // 'register' | 'exempt'
  const next = actions.map((a) => (a.type === "coverage_register" ? { ...a, status: "approved", decision } : a));
  const { error } = await admin
    .from("agent_jobs")
    .update({ status: "queued_resume", pending_actions: next, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, action });
}
