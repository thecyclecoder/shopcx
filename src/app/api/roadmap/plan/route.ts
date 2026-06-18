/**
 * Goal-decomposition dispatch (Goal Decomposition Engine).
 *   POST /api/roadmap/plan   { goalSlug }  → owner queues a PLAN job (kind='plan') for a goal
 *   GET  /api/roadmap/plan?goalSlug=…      → latest plan job for that goal (polling)
 *
 * A plan job runs the plan-goal skill on the box (NOT build-spec): it reads the goal doc + the brain,
 * does brain-cited gap analysis, and proposes a milestone → spec tree back as pending_actions (one
 * `type:'spec'` action per proposed branch) → job → needs_approval. Approving branches (reusing
 * /api/roadmap/approve) resumes the job, which authors exactly the approved specs and queues their
 * builds. Planner proposes, human disposes — no spec is authored until the owner approves.
 * See docs/brain/specs/goal-decomposition-engine.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLatestPlanJob, type AgentJob } from "@/lib/agent-jobs";

const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";

// A plan is "in flight" through any of these — block a second plan for the same goal.
const PLAN_ACTIVE = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume"];

async function ghGoalExists(slug: string): Promise<boolean> {
  const tok = process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
  if (!tok) return true; // can't check (local dev without token) — let the worker validate
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/docs/brain/goals/${slug}.md?ref=main`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  return res.ok;
}

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
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can plan a goal" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { goalSlug?: unknown };
  const goalSlug = body.goalSlug;
  if (typeof goalSlug !== "string" || !/^[a-z0-9-]+$/i.test(goalSlug)) {
    return NextResponse.json({ error: "bad goalSlug" }, { status: 400 });
  }
  if (!(await ghGoalExists(goalSlug))) {
    return NextResponse.json({ error: `goal not found: docs/brain/goals/${goalSlug}.md` }, { status: 404 });
  }

  // One active plan per goal (same guard as one active build per spec).
  const existing = await getLatestPlanJob(workspaceId, goalSlug);
  if (existing && PLAN_ACTIVE.includes(existing.status)) {
    return NextResponse.json({ job: existing, alreadyActive: true });
  }

  // A prior (terminal) plan job → this is a RE-PLAN: tell the planner to skip already-decided branches.
  const isReplan = !!existing;
  const { data: job, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: workspaceId,
      spec_slug: goalSlug,
      kind: "plan",
      status: "queued",
      instructions: isReplan
        ? "RE-PLAN: propose only newly-revealed gaps. Do NOT re-propose any branch already shipped (✅) or declined (❌) in the goal doc's Decomposition, and never touch already-approved/in-flight branches."
        : null,
      created_by: user.id,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: job as AgentJob, replan: isReplan });
}
