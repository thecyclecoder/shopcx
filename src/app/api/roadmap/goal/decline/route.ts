/**
 * POST /api/roadmap/goal/decline  { slug }
 *
 * The CEO's decline-a-proposed-goal companion to /greenlight — flips `proposed` → `folded` in one
 * DB write (goal-greenlight-button-and-author-writes-db Phase 1). The row stays for audit; the
 * mirror-md lane (Phase 4) reflects the new status on main. Replaces director-proposed-goals
 * Phase 1's "Decline → delete `.md` from main" executor path: nothing is git-rm'd from this route.
 *
 * `'folded'` (not a new `'declined'` enum value) is the carrier — `goals.status` already has
 * `('proposed','greenlit','complete','folded')`, and the spec lets the author choose to absorb
 * decline into `folded`. No migration needed.
 *
 * CEO-only — same gate as `/greenlight`. Audit row: `action_kind='declined_goal'`.
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

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the CEO can decline a goal" }, { status: 403 });
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
  if (goal.status !== "proposed") {
    return NextResponse.json(
      { error: `goal "${slug}" is ${goal.status}, not proposed — nothing to decline` },
      { status: 409 },
    );
  }

  await setGoalStatus(goal.id, "folded", user.id);

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "ceo",
    actionKind: "declined_goal",
    specSlug: null,
    reason: `Declined goal ${slug}: ${goal.title}`,
    metadata: { goal_id: goal.id, goal_slug: slug, actor_user_id: user.id },
  });

  revalidatePath("/dashboard/roadmap/goals");
  revalidatePath(`/dashboard/roadmap/goals/${slug}`);
  return NextResponse.json({ ok: true, goalId: goal.id, status: "folded" });
}
