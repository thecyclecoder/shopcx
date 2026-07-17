/**
 * GET /api/developer/agents/recap?date=YYYY-MM-DD&function={slug} — the human-readable EOD day
 * narrative (director-loop-grading spec, Phase 5).
 *
 * Owner-gated, read-only. The one-line standup post + Daily Summaries row are the headline; this is the
 * DRILL-DOWN the row deep-links to — a readable narrative of the director's day built purely by reading
 * that day's [[director_activity]] rows (what it fixed + why, which goal it moved + how far, what it
 * escalated). With `function` → just that director's day; without → every active director (the CEO
 * roll-up). A query over the activity log, recomputed each view, never hand-maintained.
 * See docs/brain/libraries/director-recap.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildDirectorDayNarrative } from "@/lib/agents/director-recap";


export async function GET(req: Request) {
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
    return NextResponse.json({ error: "Only the workspace owner can view director recaps" }, { status: 403 });
  }

  const url = new URL(req.url);
  const date = url.searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  const functionSlug = url.searchParams.get("function") || undefined;

  const narrative = await buildDirectorDayNarrative({ workspaceId, date, functionSlug });
  return NextResponse.json(narrative);
}
