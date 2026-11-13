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
 *
 * self-verify-circuit-not-reset-by-owner-dismissed-failed-build Phase 1 — dismissing a failed build
 * nulls `error` and flips status to `completed`, which resets `selfVerifyCircuitDecision`'s
 * consecutive-failed streak so the N=3 breaker in `enqueueBuildIfDue` can never open; the spec then
 * re-queues the identical doomed build every tick and re-fires Mario forever. So BEFORE nulling the
 * error we derive the pre-commit self-verify signature from `job.error`; when the dismissed job is a
 * `kind='build'` with a non-null signature we park the spec (auto_build off + a human_review
 * breadcrumb) — the SAME terminal state the circuit breaker produces when it opens — so the
 * dismissed-failed spec lands for human review instead of looping.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveSelfVerifySignature } from "@/lib/agent-jobs";

export async function POST(request: Request) {
  const { user } = await getAuthedUser();
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
    .select("id, workspace_id, kind, status, error, spec_slug")
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
  const dismissedAt = new Date().toISOString();
  const breadcrumb = `dismissed by owner (${actor}) at ${dismissedAt}`;

  // Derive the self-verify signature BEFORE the update nulls `error` — a build whose error carries a
  // pre-commit self-verify signature is the circuit-break class the spec warns about. Capturing it now
  // lets us park the spec below once the dismiss lands.
  const selfVerifySignature =
    job.kind === "build" ? deriveSelfVerifySignature((job as { error: string | null }).error) : null;

  const { error: updateErr } = await admin
    .from("agent_jobs")
    .update({
      status: "completed",
      error: null,
      log_tail: breadcrumb,
      updated_at: dismissedAt,
    })
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .eq("status", "failed");
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  // self-verify-circuit-not-reset-by-owner-dismissed-failed-build Phase 1 — if the dismissed job was a
  // build whose error carried a pre-commit self-verify signature, park auto_build so the dismiss can't
  // silently reset selfVerifyCircuitDecision's streak and let enqueueBuildIfDue re-queue the identical
  // doomed build (re-firing Mario forever). This mirrors the circuit-open park in
  // enqueueBuildIfDue (agent-jobs.ts) so a dismissed self-verify-failed spec lands for human review
  // instead of looping. The spec slug is resolved from the job row. Best-effort: a park write failure
  // must not fail the dismiss itself (the row is already flipped idempotently above).
  const specSlug = (job as { spec_slug: string | null }).spec_slug;
  if (selfVerifySignature && specSlug) {
    const reasonText =
      `auto-build parked: owner (${actor}) dismissed a failed build whose error carried a pre-commit ` +
      `self-verify signature. Re-building would re-fail identically, so this spec is held for human ` +
      `review instead of re-queuing. Dismissed at ${dismissedAt}. Signature: ${selfVerifySignature.slice(0, 300)}`;
    try {
      const { setSpecAutoBuild, setSpecHumanReview } = await import("@/lib/specs-table");
      await setSpecAutoBuild(workspaceId, specSlug, false);
      await setSpecHumanReview(workspaceId, specSlug, reasonText);
    } catch (e) {
      console.warn(
        `[dismiss-failed] self-verify park failed for ${specSlug}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return NextResponse.json({ ok: true, jobId });
}
