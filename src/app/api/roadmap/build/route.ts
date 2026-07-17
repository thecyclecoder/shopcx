/**
 * Roadmap build dispatch.
 *   POST /api/roadmap/build   { slug }  → owner queues a build (insert agent_jobs row)
 *   GET  /api/roadmap/build?slug=…      → latest job for that spec (polling)
 *   GET  /api/roadmap/build              → latest job per spec (map) for the workspace
 *
 * The box worker (poll loop, off the tailnet) claims queued rows via claim_agent_job().
 * See docs/brain/specs/roadmap-build-console.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { getLatestJobsBySlug, getPendingFolds, reconcileMergedJobs } from "@/lib/agent-jobs";
import { queueRoadmapBuild, createPrForJob } from "@/lib/roadmap-actions";

async function ctx() {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { error: NextResponse.json({ error: "No workspace" }, { status: 400 }) };
  return { user, workspaceId };
}

export async function GET(request: Request) {
  const c = await ctx();
  if ("error" in c) return c.error;
  const slug = new URL(request.url).searchParams.get("slug");
  const [map, folds] = await Promise.all([getLatestJobsBySlug(c.workspaceId), getPendingFolds(c.workspaceId)]);
  await reconcileMergedJobs(Object.values(map));
  if (slug) return NextResponse.json({ job: map[slug] ?? null, fold: folds[slug] ?? null });
  return NextResponse.json({ jobs: map, folds });
}

export async function POST(request: Request) {
  const c = await ctx();
  if ("error" in c) return c.error;
  const { user, workspaceId } = c;

  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; instructions?: unknown; verify?: unknown; jobId?: unknown; recoverPr?: unknown; chainPhases?: unknown };

  // Create PR recovery (build-recover-pr-create): a build that pushed its branch but failed `gh pr create`
  // sits in needs_attention. Open the PR for that pushed branch instead of discarding it via Rebuild.
  if (body.recoverPr === true) {
    const result = await createPrForJob(workspaceId, user.id, { jobId: typeof body.jobId === "string" ? body.jobId : "" });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ job: result.job, adopted: result.adopted });
  }

  // Shared, owner-gated, server-revalidated logic (also called by the Slack Roadmap Console).
  const result = await queueRoadmapBuild(workspaceId, user.id, {
    slug: typeof body.slug === "string" ? body.slug : "",
    instructions: typeof body.instructions === "string" ? body.instructions : null,
    verify: body.verify === true,
    chainPhases: body.chainPhases === true,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ job: result.job, alreadyActive: result.alreadyActive, queuedBehindActive: result.queuedBehindActive, fold: result.fold, chainPhases: result.chainPhases });
}
