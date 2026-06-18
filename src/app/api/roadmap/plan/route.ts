/**
 * Goal planning dispatch (the altitude above /api/roadmap/build).
 *   POST /api/roadmap/plan   { slug }  → owner queues a PLAN job for a goal (insert agent_jobs kind='plan')
 *
 * The box worker claims it via claim_agent_job() (kind-agnostic) and branches on `kind`: a plan job
 * runs the plan-goal skill → proposes a milestone → spec tree as pending_actions → needs_approval.
 * The GOAL slug rides in spec_slug (one active plan per goal — same guard as one active build per spec).
 * "Re-plan" is just another POST once no active plan exists. See docs/brain/specs/goal-decomposition-engine.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ACTIVE_STATUSES, type AgentJob } from "@/lib/agent-jobs";
import { getGoal } from "@/lib/brain-roadmap";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can plan a goal" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { slug?: unknown };
  const slug = body.slug;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/i.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }
  // The goal doc must exist — the planner reads docs/brain/goals/{slug}.md.
  if (!(await getGoal(slug))) return NextResponse.json({ error: "goal not found" }, { status: 404 });

  // One active plan per goal (same guard shape as one active build per spec).
  const { data: existing } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "plan")
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
      kind: "plan",
      status: "queued",
      created_by: user.id,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: job as AgentJob });
}
