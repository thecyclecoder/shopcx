/**
 * POST /api/developer/director-activity/reopen-park — the CEO's override on the Director's
 * `dismiss-park` action ([[../specs/director-dismiss-park-and-short-circuit-spec]] Phase 1). Mirrors the
 * repair-dismissal reopen surface (POST /api/developer/control-tower/repair, action='reopen'):
 *
 *   { jobId } → flip the agent_jobs row back to `needs_attention` (clears `dismissed_by_director` so the
 *               auto-router sees it again), zero the `error` marker the dismiss wrote, and log a
 *               `reopened_park` director_activity row so the dismissed_park entry stops carrying its
 *               Re-open button on the next render of the activity feed.
 *
 * Owner-gated. A wrongly-dismissed park is one tap from re-routing.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
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
    return NextResponse.json({ error: "Only the workspace owner can re-open a dismissed park" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown };
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

  const { data: job } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, kind, spec_slug, status, needs_attention_class")
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "agent_jobs row not found" }, { status: 404 });
  if (job.status !== "dismissed" || job.needs_attention_class !== "dismissed_by_director") {
    return NextResponse.json(
      { error: `agent_jobs row is ${job.status} (${job.needs_attention_class ?? "no class"}) — not a director-dismissed park` },
      { status: 409 },
    );
  }

  // Flip the row back: status='needs_attention', class cleared (the auto-router classifier will re-stamp
  // it on its next pass via the same `update`-helper chokepoint), error cleared so it carries no stale marker.
  const { error } = await admin
    .from("agent_jobs")
    .update({
      status: "needs_attention",
      needs_attention_class: null,
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "platform",
    actionKind: "reopened_park",
    specSlug: (job.spec_slug as string | null) ?? null,
    reason: "CEO re-opened a dismissed park — restored the parked row and cleared the dismissal marker.",
    metadata: {
      job_id: jobId,
      target_kind: job.kind,
      spec_slug: (job.spec_slug as string | null) ?? null,
      reopened_by: "owner",
    },
  });

  return NextResponse.json({ ok: true });
}
