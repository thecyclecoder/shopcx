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
 *   { jobId, action: 'reopen' }  → the CEO's override on one of the Director's (Ada's) dismissals
 *                                  (director-supervised-repair-dismissal Phase 2): re-open the
 *                                  originating error_events row + re-enqueue Rafa for a fresh triage,
 *                                  and log a `reopened_repair` row so it leaves the dismissed list.
 *
 * Owner-gated. The build is NEVER queued without this tap (unless the verdict was on the narrow
 * REPAIR_AUTOBUILD_KINDS allow-list, which auto-queues inside the box and never surfaces here).
 *
 * See docs/brain/specs/repair-agent.md · docs/brain/specs/director-supervised-repair-dismissal.md · docs/brain/libraries/repair-agent.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueRepairJob } from "@/lib/repair-agent";
import { recordDirectorActivity } from "@/lib/director-activity";

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
    return NextResponse.json({ error: "Only the workspace owner can act on a repair item" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown; action?: unknown };
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const action = body.action === "build" || body.action === "dismiss" || body.action === "reopen" ? body.action : null;
  if (!jobId || !action) return NextResponse.json({ error: "jobId and action ('build'|'dismiss'|'reopen') are required" }, { status: 400 });

  const { data: job } = await admin
    .from("agent_jobs")
    .select("id, kind, status, spec_slug, instructions, pending_actions")
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .eq("kind", "repair")
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "Repair job not found" }, { status: 404 });

  if (action === "reopen") {
    // The CEO's override on Ada's dismissal: a dismissed item is a `completed` repair job — re-open its
    // error + re-enqueue Rafa so it re-triages, and log `reopened_repair` so it leaves the dismissed list.
    if (job.status !== "completed") {
      return NextResponse.json({ error: `Repair job is ${job.status}, not a dismissed item to re-open` }, { status: 409 });
    }
    // Restore the warning — the inverse of the dismiss (which resolved the row). Clear the resolution
    // marker so the re-opened row carries no stale "resolved" reason (fix-error-reconcile-endless-loop Phase 1).
    if (job.spec_slug) {
      await admin.from("error_events").update({ status: "open", resolved_at: null, resolution_reason: null }).eq("signature", job.spec_slug).eq("status", "resolved");
    }
    // Re-enqueue Rafa for a fresh triage, re-firing the SAME brief (source/title/error refs) from the job.
    let instr: { source?: unknown; title?: unknown; signature?: unknown; error_event_id?: unknown; loop_alert_id?: unknown; members?: unknown } = {};
    try {
      instr = job.instructions ? JSON.parse(String(job.instructions)) : {};
    } catch {
      /* instructions not JSON — fall back to the signature below */
    }
    const signature = job.spec_slug || (typeof instr.signature === "string" ? instr.signature : "");
    // A dismissed `cluster:repair` job batches N signatures in instructions.members — carry them through so the
    // re-triage investigates the SAME cluster instead of an empty '0 signatures' brief (members are dropped today).
    const members = Array.isArray(instr.members)
      ? (instr.members as Array<Record<string, unknown>>).map((m) => ({
          source: typeof m.source === "string" ? m.source : "",
          signature: typeof m.signature === "string" ? m.signature : "",
          title: typeof m.title === "string" ? m.title : "",
          errorEventId: typeof m.errorEventId === "string" ? m.errorEventId : null,
          loopAlertId: typeof m.loopAlertId === "string" ? m.loopAlertId : null,
        }))
      : undefined;
    const requeue = await enqueueRepairJob(admin, {
      source: typeof instr.source === "string" && instr.source ? instr.source : (signature.split(":")[0] || "vercel"),
      signature,
      title: typeof instr.title === "string" && instr.title ? instr.title : signature || "re-opened repair",
      errorEventId: typeof instr.error_event_id === "string" ? instr.error_event_id : null,
      loopAlertId: typeof instr.loop_alert_id === "string" ? instr.loop_alert_id : null,
      members,
    });
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: "platform",
      actionKind: "reopened_repair",
      specSlug: null,
      reason: "Owner re-opened Ada's dismissal — restored the warning and re-enqueued Rafa for a fresh triage.",
      metadata: { repair_job_id: jobId, signature, requeued: requeue.enqueued, reopened_by: "owner" },
    });
    return NextResponse.json({ ok: true, action, requeued: requeue.enqueued });
  }

  // Both proposed (needs_approval) and needs-human (needs_attention) items are dismissible; only a
  // proposed item (which carries a repair_build action) can be Built.
  if (job.status !== "needs_approval" && job.status !== "needs_attention") {
    return NextResponse.json({ error: `Repair job is ${job.status}, not actionable` }, { status: 409 });
  }
  if (action === "build" && job.status !== "needs_approval") {
    return NextResponse.json({ error: "No proposed fix to build on this item — Dismiss it instead." }, { status: 409 });
  }

  const actions = Array.isArray(job.pending_actions) ? (job.pending_actions as Array<Record<string, unknown>>) : [];

  if (action === "dismiss") {
    // Dismiss resolves DIRECTLY — resolving a row needs no prod creds, so no box round-trip. This also
    // makes Dismiss work for needs_attention items (which have no repair_build action to decline) and
    // clears them from getOpenRepairs immediately (status → completed).
    const next = actions.map((a) => (a.type === "repair_build" ? { ...a, status: "declined" } : a));
    const { error } = await admin
      .from("agent_jobs")
      .update({ status: "completed", pending_actions: next, error: "dismissed by owner", updated_at: new Date().toISOString() })
      .eq("id", jobId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // Resolve the originating error_events row (the repair job's spec_slug IS the error signature, e.g. "vercel:…")
    // with a recorded reason — terminal (fix-error-reconcile-endless-loop Phase 1).
    if (job.spec_slug) {
      await admin
        .from("error_events")
        .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_reason: "dismissed by owner" })
        .eq("signature", job.spec_slug);
    }
    return NextResponse.json({ ok: true, action, resolved: true });
  }

  // action === "build": approve the repair_build action + flip to queued_resume so the box re-claims it
  // on the repair lane and enqueues the build (the build genuinely needs the box).
  const next = actions.map((a) => (a.type === "repair_build" ? { ...a, status: "approved" } : a));
  const { error } = await admin
    .from("agent_jobs")
    .update({ status: "queued_resume", pending_actions: next, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, action });
}
