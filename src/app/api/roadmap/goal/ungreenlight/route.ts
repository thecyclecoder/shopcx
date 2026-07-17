/**
 * POST /api/roadmap/goal/ungreenlight  { slug }
 *
 * The CEO's reversal of a greenlight (goal-greenlight-button-and-author-writes-db Phase 1 / Safety
 * & invariants) — flips `greenlit` → `proposed` in one DB write. Guards against a misclick spending
 * compute on a goal the CEO didn't mean to activate.
 *
 * - CEO-only — same gate as `/greenlight`.
 * - Refuses (409) if any child milestone has rolled past `planned` (i.e. any child spec is in_progress
 *   or shipped). Once progress lands, the goal is pinned forward by the spec's safety invariant; the
 *   un-greenlight is for the "no progress yet" window.
 * - Audit: one `director_activity` row with `action_kind='ungreenlit_goal'`.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGoal, setGoalStatus } from "@/lib/goals-table";
import { getGoals } from "@/lib/brain-roadmap";
import { recordDirectorActivity } from "@/lib/director-activity";

export async function POST(request: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the CEO can un-greenlight a goal" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { slug?: unknown };
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }

  const goal = await getGoal(workspaceId, slug);
  if (!goal) {
    return NextResponse.json({ error: `goal "${slug}" not found` }, { status: 404 });
  }
  if (goal.status !== "greenlit") {
    return NextResponse.json(
      { error: `goal "${slug}" is ${goal.status}, not greenlit — nothing to revert` },
      { status: 409 },
    );
  }

  // The safety rail: once any child milestone advances past `planned`, the goal is pinned forward.
  // Milestone progress is DERIVED from child specs (no rollup column), so read it off the GoalCard the
  // roadmap deriver produces — a milestone with completion > 0 (status not "planned") has progress landed.
  const card = (await getGoals(workspaceId)).find((g) => g.slug === slug);
  const movedMilestone = card?.milestones.find((m) => m.status !== "planned" || m.completion > 0);
  if (movedMilestone) {
    return NextResponse.json(
      {
        error: `goal "${slug}" has progress on milestone "${movedMilestone.name}" (${movedMilestone.status}) — refuse to revert`,
      },
      { status: 409 },
    );
  }

  await setGoalStatus(goal.id, "proposed", user.id);

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "ceo",
    actionKind: "ungreenlit_goal",
    specSlug: null,
    reason: `Reverted goal ${slug} to proposed: ${goal.title}`,
    metadata: { goal_id: goal.id, goal_slug: slug, actor_user_id: user.id },
  });

  revalidatePath("/dashboard/roadmap/goals");
  revalidatePath(`/dashboard/roadmap/goals/${slug}`);
  return NextResponse.json({ ok: true, goalId: goal.id, status: "proposed" });
}
