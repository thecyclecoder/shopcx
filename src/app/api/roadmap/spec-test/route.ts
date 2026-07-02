/**
 * POST /api/roadmap/spec-test — the "Test now" on-demand trigger for the box spec-test QA agent
 * (spec-test-agent). Enqueues a `kind='spec-test'` agent_jobs row that the build box claims on its
 * concurrency-1 spec-test lane (runSpecTestJob) and runs as a non-destructive QA pass over the spec's
 * `## Verification` checklist on Max. Owner-gated + workspace-scoped; deduped against an in-flight job.
 *
 * Two modes:
 *  - post-ship (default): `{ slug }` → standing-lane job that probes prod. Deduped via
 *    `hasActiveSpecTestJob` against an in-flight (workspace, slug) job.
 *  - pre-merge (premerge-spectest-rerun-and-visibility Phase 3): `{ slug, branch }` where `branch`
 *    starts with `claude/` → look up the branch's latest `build` agent_jobs row, fresh-capture its
 *    Vercel preview via [[capturePreviewUrlForJob]] (so the re-test hits the branch's CURRENT HEAD, not
 *    a stale preview from a prior run), then delegate to [[enqueuePreMergeSpecTest]] with `force: true`
 *    so a stale terminal verdict (approved/needs_human/issues) does NOT block the manual re-run. The
 *    in-flight dedup still holds — you can't stack two spec-tests on the same branch. This is the
 *    "Pre-merge" surface's re-run affordance on /dashboard/developer/spec-tests. Only the in-flight
 *    dedup and a non-READY preview can refuse the re-run.
 *
 *   { slug } → enqueue → { queued: true } (or { queued: true, already: true } if one is already running)
 *   { slug, branch } → server fresh-captures preview → force-enqueue →
 *     { queued: true, mode: "pre-merge", previewUrl } (or { queued: false, reason } — in-flight /
 *     no build for the branch / preview not READY yet)
 *
 * The box generates; it NEVER mutates prod and NEVER marks the spec verified. See docs/brain/specs/spec-test-agent.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasActiveSpecTestJob } from "@/lib/spec-test-runs";
import { enqueuePreMergeSpecTest } from "@/lib/agent-jobs";
import { capturePreviewUrlForJob } from "@/lib/preview-capture";

const isSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9-]+$/i.test(s);

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { error: NextResponse.json({ error: "No workspace" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") {
    return { error: NextResponse.json({ error: "Only the workspace owner can run spec tests" }, { status: 403 }) };
  }
  return { user, workspaceId, admin };
}

export async function POST(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const { user, workspaceId, admin } = auth;

  const body = (await request.json().catch(() => ({}))) as {
    slug?: string;
    branch?: string;
  };
  if (!isSlug(body.slug)) return NextResponse.json({ error: "slug required" }, { status: 400 });
  const slug = body.slug;

  // Pre-merge (branch) — the "Pre-merge" surface's Re-run on /dashboard/developer/spec-tests
  // (premerge-spectest-rerun-and-visibility Phase 3). The server owns the fresh preview capture: look up
  // the branch's latest `build` agent_jobs row (its preview_url column is where capturePreviewUrlForJob
  // persists) → capture the branch's current READY deployment → force-enqueue via
  // enqueuePreMergeSpecTest({force:true}). Bypasses the terminal-verdict dedup so a stuck `issues`
  // verdict on a fixed branch can be kicked from the dashboard. Only in-flight (another spec-test on
  // this branch already running) or a non-READY preview can refuse the re-run.
  if (typeof body.branch === "string" && body.branch.startsWith("claude/")) {
    const branch = body.branch;
    const { data: buildRow } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .eq("spec_branch", branch)
      .eq("kind", "build")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!buildRow) {
      return NextResponse.json({ queued: false, reason: `no build for branch ${branch}` });
    }
    const cap = await capturePreviewUrlForJob({ jobId: (buildRow as { id: string }).id, branch, commitSha: null });
    if (!cap.previewUrl || cap.previewState !== "READY") {
      return NextResponse.json({
        queued: false,
        reason: `preview not READY yet (${cap.previewState ?? "no deployment"}) — retry once Vercel finishes`,
      });
    }
    const result = await enqueuePreMergeSpecTest(workspaceId, slug, branch, cap.previewUrl, { force: true });
    if (!result.enqueued) {
      return NextResponse.json({ queued: false, reason: result.reason ?? "not enqueued" });
    }
    return NextResponse.json({ queued: true, mode: "pre-merge", previewUrl: cap.previewUrl });
  }

  if (await hasActiveSpecTestJob(workspaceId, slug)) return NextResponse.json({ queued: true, already: true });

  const { error } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: slug,
    kind: "spec-test",
    status: "queued",
    created_by: user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ queued: true });
}
