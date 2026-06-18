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
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ACTIVE_STATUSES, getLatestJobsBySlug, type AgentJob } from "@/lib/agent-jobs";

async function ctx() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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
  const map = await getLatestJobsBySlug(c.workspaceId);
  if (slug) return NextResponse.json({ job: map[slug] ?? null });
  return NextResponse.json({ jobs: map });
}

export async function POST(request: Request) {
  const c = await ctx();
  if ("error" in c) return c.error;
  const { user, workspaceId } = c;

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can start a build" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; instructions?: unknown };
  const slug = body.slug;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/i.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }

  // One active build per spec.
  const { data: existing } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return NextResponse.json({ job: existing as AgentJob, alreadyActive: true });

  const { data: job, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: workspaceId,
      spec_slug: slug,
      status: "queued",
      instructions: typeof body.instructions === "string" ? body.instructions : null,
      created_by: user.id,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: job as AgentJob });
}
