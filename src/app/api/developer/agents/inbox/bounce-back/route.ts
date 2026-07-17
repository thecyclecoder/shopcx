/**
 * POST /api/developer/agents/inbox/bounce-back — the CEO 'you handle this' affordance for a stranded
 * director escalation (bounce-escalation-back-to-director Phase 1).
 *
 * When a director escalates and the CEO inbox card only renders Dismiss, this endpoint sends the
 * escalation BACK to the originating director with the sound diagnosis it already produced, the
 * lane's richer judgment-lanes verdicts, and an optional one-line CEO note. The director
 * re-investigates and either lands an action OR re-escalates exactly once (depth cap).
 *
 * Owner-gated (mirrors the dismiss endpoint). Loads the notification, asserts it's a director
 * escalation (escalated_by_director set, routed_to_function=ceo), derives the originating lane from
 * `escalation_kind`, enforces `depth < 1`, enqueues `agent_jobs(kind='director-bounce-back')` with the
 * carried context in `instructions`, dismisses the notification, and writes a
 * `bounced_back_by_ceo` `director_activity` row.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";
import {
  BOUNCE_BACK_JOB_KIND,
  type BounceBackInstructions,
  laneForBounceBack,
} from "@/lib/agents/director-bounce-back";
import { recordDirectorActivity } from "@/lib/director-activity";


export async function POST(req: Request) {
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
    return NextResponse.json({ error: "Only the workspace owner can bounce escalations" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { notificationId?: unknown; note?: unknown };
  const notificationId = typeof body.notificationId === "string" ? body.notificationId : null;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;
  if (!notificationId) return NextResponse.json({ error: "notificationId required" }, { status: 400 });

  // Load + validate the notification — must be a CEO-routed director escalation in this workspace.
  const { data: notif } = await admin
    .from("dashboard_notifications")
    .select("id, workspace_id, type, title, body, metadata, dismissed")
    .eq("id", notificationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!notif) return NextResponse.json({ error: "notification not found" }, { status: 404 });
  if (notif.type !== APPROVAL_REQUEST_TYPE) return NextResponse.json({ error: "only escalations can be bounced" }, { status: 400 });
  if (notif.dismissed) return NextResponse.json({ error: "notification already dismissed" }, { status: 400 });

  const meta = (notif.metadata as Record<string, unknown> | null) ?? {};
  const directorSlug = typeof meta["escalated_by_director"] === "string" ? (meta["escalated_by_director"] as string) : "";
  if (!directorSlug) return NextResponse.json({ error: "no director to bounce to" }, { status: 400 });

  const lane = laneForBounceBack(meta);
  if (!lane) return NextResponse.json({ error: "only escalations can be bounced" }, { status: 400 });

  // Depth cap: a card that already came back from a bounce carries bounced_back_depth>=1 on its
  // metadata (the worker stamps it on re-escalation). One round-trip max.
  const priorDepth = typeof meta["bounced_back_depth"] === "number" ? (meta["bounced_back_depth"] as number) : 0;
  if (priorDepth >= 1) return NextResponse.json({ error: "depth cap reached" }, { status: 400 });

  const originalReason = typeof meta["escalation_reason"] === "string" ? (meta["escalation_reason"] as string) : "";
  const originalEscalationKind = typeof meta["escalation_kind"] === "string" ? (meta["escalation_kind"] as string) : null;
  const originalDedupeKey = typeof meta["dedupe_key"] === "string" ? (meta["dedupe_key"] as string) : null;
  const candidateSlug = typeof meta["spec_slug"] === "string" ? (meta["spec_slug"] as string) : null;
  const candidateJobId = typeof meta["agent_job_id"] === "string" ? (meta["agent_job_id"] as string) : null;
  // Repair-dismissal lane carries the signature on metadata via the escalateDiagnosisToCeo metadata block.
  const candidateSignature = typeof meta["signature"] === "string" ? (meta["signature"] as string) : null;

  const instructions: BounceBackInstructions = {
    lane,
    director_slug: directorSlug,
    candidate_slug: candidateSlug,
    candidate_job_id: candidateJobId,
    candidate_signature: candidateSignature,
    notification_id: notif.id as string,
    ceo_note: note,
    original_escalation_reason: originalReason,
    original_escalation_kind: originalEscalationKind,
    original_dedupe_key: originalDedupeKey,
    depth: priorDepth + 1,
  };

  // Enqueue the director-bounce-back job (claimed on the platform-director lane — concurrency 1, so
  // it never races the standing pass on the same workspace).
  const { data: enqueued, error: enqueueErr } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: workspaceId,
      spec_slug: candidateSlug ?? candidateSignature ?? "bounce-back",
      kind: BOUNCE_BACK_JOB_KIND,
      status: "queued",
      created_by: user.id,
      instructions: JSON.stringify(instructions),
    })
    .select("id")
    .single();
  if (enqueueErr || !enqueued) {
    return NextResponse.json({ error: enqueueErr?.message || "failed to enqueue bounce-back" }, { status: 500 });
  }

  // Dismiss the original notification — the bounce REPLACES the standalone Dismiss action.
  await admin
    .from("dashboard_notifications")
    .update({ dismissed: true })
    .eq("id", notificationId)
    .eq("workspace_id", workspaceId);

  // Audit: every bounce writes one director_activity row carrying the lane + reason + new job id.
  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: directorSlug,
    actionKind: "bounced_back_by_ceo",
    specSlug: candidateSlug,
    reason: note ? `CEO bounced back: ${note}` : "CEO bounced back: handle this with the richer verdict surface",
    metadata: {
      lane,
      original_notification_id: notif.id,
      original_escalation_reason: originalReason.slice(0, 2000),
      original_escalation_kind: originalEscalationKind,
      ceo_note: note,
      new_job_id: enqueued.id,
      candidate_slug: candidateSlug,
      candidate_job_id: candidateJobId,
      candidate_signature: candidateSignature,
      depth: instructions.depth,
    },
  });

  return NextResponse.json({ ok: true, jobId: enqueued.id, lane, director: directorSlug });
}
