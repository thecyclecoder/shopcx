/**
 * GET /api/roadmap/box — live build-box view (build-box-status-view).
 *
 * Returns the singleton worker_heartbeats row (enriched with the lane picture: build_lanes /
 * fold_lanes totals + a `lanes` array of what each in-flight lane is building) plus this
 * workspace's open agent_jobs split into queue-depth (waiting) and paused (needs_input /
 * needs_approval) — so /dashboard/roadmap/box can answer "is the box healthy / busy / behind?"
 * without SSH. Read-only; box infra is global so the heartbeat isn't workspace-scoped.
 *
 * See docs/brain/tables/worker_heartbeats.md + docs/brain/dashboard/roadmap.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap } from "@/lib/brain-roadmap";

export const dynamic = "force-dynamic";

interface LaneRow {
  kind: string;
  job_id: string;
  spec_slug: string;
  since: string;
}

/**
 * Pull the human-readable failure reason out of a job's log_tail. A `claude -p` run stores its
 * result JSON (`{is_error, api_error_status, result}`) — surface the 529 / Max-limit / API message
 * so the owner can tell a transient overload from a real bug. A tsc failure stores raw compiler
 * output — show its tail. Never throws; returns null when there's nothing useful.
 */
function failureDetail(logTail: string | null): string | null {
  if (!logTail) return null;
  try {
    const j = JSON.parse(logTail);
    if (j && typeof j === "object") {
      const parts: string[] = [];
      if (j.api_error_status) parts.push(`API ${j.api_error_status}`);
      if (typeof j.result === "string" && j.result.trim()) parts.push(j.result.trim());
      else if (typeof j.subtype === "string" && j.is_error) parts.push(j.subtype);
      if (parts.length) return parts.join(" — ").slice(0, 500);
    }
  } catch {
    /* not JSON (e.g. tsc output) — fall through to the tail */
  }
  return logTail.slice(-500).trim() || null;
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: hb } = await admin
    .from("worker_heartbeats")
    .select("running_sha, status, active_builds, detail, last_poll_at, started_at, build_lanes, fold_lanes, lanes")
    .eq("id", "box")
    .maybeSingle();
  const worker = hb
    ? {
        running_sha: hb.running_sha as string | null,
        status: hb.status as string,
        active_builds: hb.active_builds as number,
        detail: hb.detail as string | null,
        last_poll_at: hb.last_poll_at as string | null,
        started_at: hb.started_at as string | null,
        build_lanes: (hb.build_lanes as number | null) ?? 0,
        fold_lanes: (hb.fold_lanes as number | null) ?? 0,
        lanes: (hb.lanes as LaneRow[] | null) ?? [],
      }
    : null;

  // Open jobs (live, actionable layer) for queue depth + paused callouts.
  const { data: jobsData } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, kind, status, pr_url, pr_number, created_at")
    .eq("workspace_id", workspaceId)
    .in("status", ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume"])
    .order("created_at", { ascending: true });
  const jobs = (jobsData ?? []) as {
    id: string;
    spec_slug: string;
    kind: string;
    status: string;
    pr_url: string | null;
    pr_number: number | null;
    created_at: string;
  }[];

  // fold-guard-live-build (Phase 1) — defense in depth: a build/spec-test job whose spec page no longer
  // exists (the spec was folded → archived/deleted) must never render as a dead link. Compute the set of
  // LIVE (non-archived) spec slugs; the page routes a job with `spec_missing` to a safe target instead of
  // the would-be-404 /dashboard/roadmap/{slug}. Best-effort — a roadmap-read failure just leaves it false.
  let liveSpecSlugs = new Set<string>();
  try {
    const { specs } = await getRoadmap();
    liveSpecSlugs = new Set(specs.map((s) => s.slug));
  } catch {
    /* roadmap read failed — leave spec_missing false (no worse than today) */
  }
  // Only build-kind slugs are supposed to resolve to a spec page; non-build kinds already route elsewhere
  // (approvalHref), so a missing spec only matters for them.
  const specMissing = (kind: string, slug: string): boolean =>
    (kind === "build" || kind === "spec-test") && !liveSpecSlugs.has(slug);

  // Waiting = not yet in a lane; paused = needs owner action.
  const queue = jobs.filter((j) => j.status === "queued" || j.status === "queued_resume");
  const paused = jobs
    .filter((j) => j.status === "needs_input" || j.status === "needs_approval")
    .map((j) => ({ ...j, spec_missing: specMissing(j.kind, j.spec_slug) }));

  // Failed builds (actionable) — surface a failure so the owner doesn't have to dig into a spec
  // card to learn a build died. Only show a spec whose *latest* build attempt is `failed`: a later
  // successful/in-flight build (merged/completed/building/queued) supersedes the old failure, so a
  // since-rebuilt spec (e.g. control-tower) is NOT shown as failed.
  const { data: buildHist } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, kind, status, error, log_tail, updated_at, created_at")
    .eq("workspace_id", workspaceId)
    .in("kind", ["build", "plan"])
    .order("created_at", { ascending: false })
    .limit(500);
  type BuildJob = { id: string; spec_slug: string; kind: string; status: string; error: string | null; log_tail: string | null; updated_at: string };
  const latestBySlug = new Map<string, BuildJob>();
  for (const j of (buildHist ?? []) as BuildJob[]) {
    if (!latestBySlug.has(j.spec_slug)) latestBySlug.set(j.spec_slug, j);
  }
  const failed = [...latestBySlug.values()]
    .filter((j) => j.status === "failed")
    .map((j) => ({ id: j.id, spec_slug: j.spec_slug, kind: j.kind, error: j.error ?? null, detail: failureDetail(j.log_tail), updated_at: j.updated_at, spec_missing: specMissing(j.kind, j.spec_slug) }))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, 20);

  return NextResponse.json({ worker, queue, paused, failed });
}
