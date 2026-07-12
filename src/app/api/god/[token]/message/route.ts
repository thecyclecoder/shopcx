/**
 * POST /api/god/[token]/message — the founder sends one message.
 *
 * Phase 3 of docs/brain/specs/god-mode.md. Appends the turn to the transcript,
 * enqueues a kind='god-mode' mode:'turn' job, and renews the sliding TTL. The
 * box worker's concurrency-1 god-mode lane claims the job and runs it under
 * the Phase-2 permission gate.
 *
 * Body: { message: string } (non-empty, trimmed).
 * 404 on unknown/disarmed token; 410 on expired; 400 on empty message; 200
 * with { ok: true, job_id } on success.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  appendMessage,
  enqueueGodModeTurn,
  bumpActivity,
} from "@/lib/god-mode";
import { resolveCockpitTokenAny } from "@/lib/cockpit-resolver";
import { markThreadThinking } from "@/lib/agents/director-coach-threads";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const body = (await request.json().catch(() => ({}))) as { message?: string };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });

  const admin = createAdminClient();
  const resolved = await resolveCockpitTokenAny(admin, token);
  if (!resolved) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (resolved.kind === "god") {
    // Append the founder turn BEFORE enqueueing so the box, when it runs, always
    // sees the latest user message in the transcript column it reads back.
    await appendMessage(admin, resolved.session.id, {
      role: "user",
      content: message,
      ts: new Date().toISOString(),
    });
    const { jobId } = await enqueueGodModeTurn(admin, {
      workspaceId: resolved.session.workspace_id,
      sessionId: resolved.session.id,
      userMessage: message,
      createdBy: resolved.session.created_by ?? null,
    });
    // Slide TTL + bump last_activity_at — the message counts as activity.
    await bumpActivity(admin, resolved.session.id);
    return NextResponse.json({ ok: true, job_id: jobId });
  }

  // Director branch — append the CEO turn to director_coach_threads.messages,
  // then enqueue the SAME kind='director-coach' agent_jobs row the in-app coach
  // chat enqueues (mode='turn', intent='ask'). The M3 dispatch runs the box
  // turn AS the director on the max sandbox — never the godmode prod-write
  // sandbox — so the SMS cockpit never inherits god-mode's reach.
  const thread = resolved.thread;
  const thinking = await markThreadThinking(thread.workspace_id, thread.id, message);
  if (!thinking) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { data: job } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: thread.workspace_id,
      kind: "director-coach",
      spec_slug: thread.id,
      status: "queued",
      instructions: JSON.stringify({ thread_id: thread.id, mode: "turn", intent: "ask" }),
      created_by: thread.user_id ?? null,
    })
    .select("id")
    .single();
  return NextResponse.json({ ok: true, job_id: (job as { id: string } | null)?.id ?? null });
}
