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

export const dynamic = "force-dynamic";

interface LaneRow {
  kind: string;
  job_id: string;
  spec_slug: string;
  since: string;
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

  // Waiting = not yet in a lane; paused = needs owner action.
  const queue = jobs.filter((j) => j.status === "queued" || j.status === "queued_resume");
  const paused = jobs.filter((j) => j.status === "needs_input" || j.status === "needs_approval");

  return NextResponse.json({ worker, queue, paused });
}
