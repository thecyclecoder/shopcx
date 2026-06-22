/**
 * POST /api/developer/control-tower/repair — the owner's Build/Dismiss on a surfaced Repair Agent
 * item (repair-agent spec, Phase 1). Mirrors escalation-triage: the box PROPOSES (authors a fix spec
 * + surfaces it), the OWNER finalizes here.
 *
 *   { jobId, action: 'build' }   → approve the repair_build action + flip the job to queued_resume;
 *                                  the box's runRepairJob queues the actual feature build for the
 *                                  authored fix spec (the owner-gate the North star keeps).
 *   { jobId, action: 'dismiss' } → decline it + flip to queued_resume; the box resolves the
 *                                  originating error_events row and clears the surfaced item.
 *
 * Owner-gated. The build is NEVER queued without this tap (unless the verdict was on the narrow
 * REPAIR_AUTOBUILD_KINDS allow-list, which auto-queues inside the box and never surfaces here).
 *
 * See docs/brain/specs/repair-agent.md · docs/brain/libraries/repair-agent.md.
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
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can act on a repair item" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown; action?: unknown };
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const action = body.action === "build" || body.action === "dismiss" ? body.action : null;
  if (!jobId || !action) return NextResponse.json({ error: "jobId and action ('build'|'dismiss') are required" }, { status: 400 });

  const { data: job } = await admin
    .from("agent_jobs")
    .select("id, kind, status, pending_actions")
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .eq("kind", "repair")
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "Repair job not found" }, { status: 404 });
  if (job.status !== "needs_approval") {
    return NextResponse.json({ error: `Repair job is ${job.status}, not awaiting approval` }, { status: 409 });
  }

  const actions = Array.isArray(job.pending_actions) ? (job.pending_actions as Array<Record<string, unknown>>) : [];
  const next = actions.map((a) =>
    a.type === "repair_build" ? { ...a, status: action === "build" ? "approved" : "declined" } : a,
  );

  // Flip to queued_resume so the box re-claims it on the repair lane and executes the owner's choice
  // (queue the build / resolve the error row). The box owns the actual build enqueue + row resolve.
  const { error } = await admin
    .from("agent_jobs")
    .update({ status: "queued_resume", pending_actions: next, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, action });
}
