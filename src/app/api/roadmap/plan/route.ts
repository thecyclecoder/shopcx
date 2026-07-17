/**
 * Roadmap planner dispatch (Goal Decomposition Engine).
 *   POST /api/roadmap/plan   { goalSlug }      → owner queues a PLAN job (kind='plan')
 *   GET  /api/roadmap/plan?goalSlug=…          → latest plan job for that goal (polling)
 *
 * A plan job runs the plan-goal skill on the box: gap-analyze the goal against the brain and
 * propose a milestone→spec tree as pending_actions (type:'spec') → needs_approval. The owner
 * approves branches (/api/roadmap/approve); the worker then auto-authors the approved specs +
 * queues their builds. One active plan per goal. See docs/brain/specs/goal-decomposition-engine.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ACTIVE_STATUSES, getLatestPlanJob, type AgentJob } from "@/lib/agent-jobs";
import { getGoal } from "@/lib/brain-roadmap";

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
  const goalSlug = new URL(request.url).searchParams.get("goalSlug");
  if (!goalSlug || !/^[a-z0-9-]+$/i.test(goalSlug)) return NextResponse.json({ error: "bad goalSlug" }, { status: 400 });
  return NextResponse.json({ job: await getLatestPlanJob(c.workspaceId, goalSlug) });
}

export async function POST(request: Request) {
  const c = await ctx();
  if ("error" in c) return c.error;
  const { user, workspaceId } = c;

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (member.role !== "owner") return NextResponse.json({ error: "Only the workspace owner can plan a goal" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { goalSlug?: unknown; instructions?: unknown };
  const goalSlug = body.goalSlug;
  if (typeof goalSlug !== "string" || !/^[a-z0-9-]+$/i.test(goalSlug)) {
    return NextResponse.json({ error: "bad goalSlug" }, { status: 400 });
  }

  // director-proposed-goals (Phase 2): only a GREENLIT goal is eligible for decomposition. A `proposed`
  // goal a director authored is INERT until the CEO greenlights it (its own Approval Request) — Pia never
  // decomposes a goal the CEO hasn't activated. (A missing goal doc is left to the box to surface.)
  const goal = await getGoal(goalSlug);
  if (goal && goal.card.status === "proposed") {
    return NextResponse.json(
      { error: "This goal is still proposed — greenlight it before Pia can decompose it." },
      { status: 409 },
    );
  }

  // One active plan per goal (mirrors one active build per spec).
  const { data: existing } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("kind", "plan")
    .eq("spec_slug", goalSlug)
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return NextResponse.json({ job: existing as AgentJob, alreadyActive: true });

  const { data: job, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: workspaceId,
      spec_slug: goalSlug,
      kind: "plan",
      status: "queued",
      instructions: typeof body.instructions === "string" ? body.instructions : null,
      created_by: user.id,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: job as AgentJob });
}
