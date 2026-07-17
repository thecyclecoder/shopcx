/**
 * POST /api/developer/control-tower/db-health — the owner's Build/Dismiss on a surfaced DB Health
 * Agent proposal (db-health-agent spec, Phase 1). Mirrors the repair route: the box PROPOSES (detects
 * read-only + pre-authors the fix spec), the OWNER finalizes here.
 *
 *   { jobId, action: 'build' }   → approve the db_health_build action + flip the job to queued_resume;
 *                                  the box's runDbHealthJob commits the pre-authored fix spec to main
 *                                  and queues the actual build (the owner-gate the North star keeps —
 *                                  NO DDL/deletes are ever applied without this tap).
 *   { jobId, action: 'dismiss' } → resolve the proposal directly (no box round-trip).
 *
 * Owner-gated. See docs/brain/specs/db-health-agent.md · docs/brain/libraries/db-health.md.
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
    return NextResponse.json({ error: "Only the workspace owner can act on a DB Health proposal" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown; action?: unknown };
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const action = body.action === "build" || body.action === "dismiss" ? body.action : null;
  if (!jobId || !action) return NextResponse.json({ error: "jobId and action ('build'|'dismiss') are required" }, { status: 400 });

  const { data: job } = await admin
    .from("agent_jobs")
    .select("id, kind, status, spec_slug, pending_actions")
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .eq("kind", "db_health")
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "DB Health proposal not found" }, { status: 404 });
  if (job.status !== "needs_approval" && job.status !== "needs_attention") {
    return NextResponse.json({ error: `Proposal is ${job.status}, not actionable` }, { status: 409 });
  }
  if (action === "build" && job.status !== "needs_approval") {
    return NextResponse.json({ error: "No proposed fix to build on this item — Dismiss it instead." }, { status: 409 });
  }

  const actions = Array.isArray(job.pending_actions) ? (job.pending_actions as Array<Record<string, unknown>>) : [];

  if (action === "dismiss") {
    // Dismiss resolves directly — no prod creds needed, and it clears the panel immediately.
    const next = actions.map((a) => (a.type === "db_health_build" ? { ...a, status: "declined" } : a));
    const { error } = await admin
      .from("agent_jobs")
      .update({ status: "completed", pending_actions: next, error: "dismissed by owner", updated_at: new Date().toISOString() })
      .eq("id", jobId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, action, resolved: true });
  }

  // action === "build": approve the db_health_build action + flip to queued_resume so the box
  // re-claims it on the db_health lane, commits the pre-authored fix spec to main, and queues the build.
  const next = actions.map((a) => (a.type === "db_health_build" ? { ...a, status: "approved" } : a));
  const { error } = await admin
    .from("agent_jobs")
    .update({ status: "queued_resume", pending_actions: next, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, action });
}
