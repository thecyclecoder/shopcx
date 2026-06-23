/**
 * GET /api/developer/agents/recap?function={slug|ceo}&date={YYYY-MM-DD} — the human-readable EOD
 * recap detail (director-loop-grading spec, Phase 5).
 *
 * Owner-gated, read-only. Returns the director's (or the CEO roll-up's) day narrated: the headline
 * standup counts plus that day's [[director_activity]] rows grouped into readable sections (what it
 * fixed + why · which goal it moved · what it escalated). A pure query over the activity log — never
 * hand-maintained. Backs the detail page reached from the M1 Daily Summaries tab. See
 * docs/brain/libraries/director-recap.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildDirectorDayDetail } from "@/lib/agents/director-recap";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
    return NextResponse.json({ error: "Only the workspace owner can view the EOD recap" }, { status: 403 });
  }

  const url = new URL(req.url);
  const functionSlug = url.searchParams.get("function") || "ceo";
  const date = url.searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "A valid date (YYYY-MM-DD) is required" }, { status: 400 });
  }

  const detail = await buildDirectorDayDetail(workspaceId, date, functionSlug);
  return NextResponse.json(detail);
}
