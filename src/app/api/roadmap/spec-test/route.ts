/**
 * POST /api/roadmap/spec-test — the "Test now" on-demand trigger for the box spec-test QA agent
 * (spec-test-agent). Enqueues a `kind='spec-test'` agent_jobs row that the build box claims on its
 * concurrency-1 spec-test lane (runSpecTestJob) and runs as a non-destructive QA pass over the spec's
 * `## Verification` checklist on Max. Owner-gated + workspace-scoped; deduped against an in-flight job.
 *
 * Two modes (spectest-error-visible-and-rerunnable Phase 2):
 *  - post-ship (default): `{ slug }` → standing-lane job that probes prod. Deduped via
 *    `hasActiveSpecTestJob` against an in-flight (workspace, slug) job.
 *  - pre-merge: `{ slug, branch, previewUrl }` where `branch` starts with `claude/` → delegates to
 *    [[enqueuePreMergeSpecTest]] which stamps `spec_branch` + `preview_url` so the runner probes the
 *    per-build `*.vercel.app` preview instead of prod. Dedupe is per-branch; the re-run affordance for
 *    the "Pre-merge / errored" surface on /dashboard/developer/spec-tests.
 *
 *   { slug } → enqueue → { queued: true } (or { queued: true, already: true } if one is already running)
 *   { slug, branch, previewUrl } → { queued: true } (or { queued: false, reason } when the branch was
 *   already tested with a real verdict / a run is in-flight)
 *
 * The box generates; it NEVER mutates prod and NEVER marks the spec verified. See docs/brain/specs/spec-test-agent.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasActiveSpecTestJob } from "@/lib/spec-test-runs";
import { enqueuePreMergeSpecTest } from "@/lib/agent-jobs";

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
    previewUrl?: string;
  };
  if (!isSlug(body.slug)) return NextResponse.json({ error: "slug required" }, { status: 400 });
  const slug = body.slug;

  // Pre-merge (branch + previewUrl) — re-fire a per-branch spec-test against its per-build preview,
  // routing through the shared enqueuePreMergeSpecTest so it stamps `spec_branch` + `preview_url` and
  // uses the branch-scoped dedupe (an `error` verdict falls through so a reaped session can re-run; a
  // real approved/needs_human/issues verdict blocks). The re-run affordance for the
  // "Pre-merge / errored" surface on /dashboard/developer/spec-tests.
  if (typeof body.branch === "string" && body.branch.startsWith("claude/")) {
    const previewUrl = typeof body.previewUrl === "string" ? body.previewUrl : "";
    if (!previewUrl) {
      return NextResponse.json({ error: "previewUrl required for pre-merge re-run" }, { status: 400 });
    }
    const result = await enqueuePreMergeSpecTest(workspaceId, slug, body.branch, previewUrl);
    if (!result.enqueued) {
      return NextResponse.json({ queued: false, reason: result.reason ?? "not enqueued" });
    }
    return NextResponse.json({ queued: true, mode: "pre-merge" });
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
