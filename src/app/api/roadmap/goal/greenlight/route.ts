/**
 * POST /api/roadmap/goal/greenlight  { slug }
 *
 * The CEO's one-click greenlight (goal-greenlight-button-and-author-writes-db Phase 1) — flips the
 * goal row from `proposed` → `greenlit` in a single DB write. The first-class replacement for the
 * old `**Status:** proposed → greenlit` markdown commit + Vercel deploy (director-proposed-goals
 * Phase 1 verification), and the surface the CEO Outcome of [[../../goals/db-driven-specs]] M5
 * calls out by name ("the CEO literally had no surface to approve the goal").
 *
 * - CEO-only: gated on `workspace_members.role='owner'` (the workspace owner IS the CEO). Mirrors
 *   the approval-routing-engine CEO-only rail; a director's `live=true autonomous=true` setting does
 *   NOT let them greenlight any goal — its own or another's.
 * - Idempotent: the DB write is `setGoalStatus(id, 'greenlit')` and the route refuses (409) if the
 *   row isn't currently `proposed`, so a double-click is a no-op rather than a confused state flip.
 * - Audit: records one `director_activity` row with `action_kind='greenlit_goal'` carrying the
 *   actor's user id, the goal slug, and the goal id in metadata. The ledger is best-effort.
 *
 * The body of this route never touches the markdown — the roadmap readers read `public.goals` directly
 * (goal-readers-from-db-retire-parsegoal), so the `setGoalStatus` row write here is the whole effect; no
 * mirror commit is needed for any surface to see the greenlight.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGoal, setGoalStatus } from "@/lib/goals-table";
import { recordDirectorActivity } from "@/lib/director-activity";

export async function POST(request: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  // CEO-only: the workspace owner is the CEO (single-tenant Superfoods setup). A director with
  // `live=true autonomous=true` does NOT pass — `member.role` is `'member'` for any non-owner.
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the CEO can greenlight a goal" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { slug?: unknown };
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }

  const goal = await getGoal(workspaceId, slug);
  if (!goal) {
    return NextResponse.json(
      { error: `goal "${slug}" not in public.goals — run backfill-goals-from-markdown` },
      { status: 404 },
    );
  }
  if (goal.status !== "proposed") {
    return NextResponse.json(
      { error: `goal "${slug}" is ${goal.status}, not proposed — nothing to greenlight` },
      { status: 409 },
    );
  }

  await setGoalStatus(goal.id, "greenlit", user.id);

  // Best-effort audit; never break the greenlight on a ledger miss.
  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "ceo",
    actionKind: "greenlit_goal",
    specSlug: null,
    reason: `Greenlit goal ${slug}: ${goal.title}`,
    metadata: { goal_id: goal.id, goal_slug: slug, actor_user_id: user.id },
  });

  revalidatePath("/dashboard/roadmap/goals");
  revalidatePath(`/dashboard/roadmap/goals/${slug}`);
  return NextResponse.json({ ok: true, goalId: goal.id, status: "greenlit" });
}
