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
  resolveCockpitToken,
  appendMessage,
  enqueueGodModeTurn,
  bumpActivity,
} from "@/lib/god-mode";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const body = (await request.json().catch(() => ({}))) as { message?: string };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });

  const admin = createAdminClient();
  const res = await resolveCockpitToken(admin, token);
  if (res.kind === "not_found" || res.kind === "disarmed") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (res.kind === "expired") {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  // Append the founder turn BEFORE enqueueing so the box, when it runs, always
  // sees the latest user message in the transcript column it reads back.
  await appendMessage(admin, res.session.id, {
    role: "user",
    content: message,
    ts: new Date().toISOString(),
  });

  const { jobId } = await enqueueGodModeTurn(admin, {
    workspaceId: res.session.workspace_id,
    sessionId: res.session.id,
    userMessage: message,
    createdBy: res.session.created_by ?? null,
  });

  // Slide TTL + bump last_activity_at — the message counts as activity.
  await bumpActivity(admin, res.session.id);

  return NextResponse.json({ ok: true, job_id: jobId });
}
