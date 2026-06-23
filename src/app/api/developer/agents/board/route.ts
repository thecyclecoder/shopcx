/**
 * GET /api/developer/agents/board — the workspace's #directors board channel
 * (directors-board-gamified spec, Phase 1).
 *
 * Owner-gated, read-only. Returns the Slack-style team channel behind the Messages tab of the M1
 * Agents-hub inbox: a workspace's [[director_messages]] threaded into top-level posts (newest-first)
 * with their replies. It's ONE shared channel — every role's Messages tab renders it (the team board,
 * not a per-role log). Two-way reply / @-mention routing is Phase 2; this only reads.
 * See docs/brain/tables/director_messages.md + docs/brain/dashboard/agents.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDirectorBoard } from "@/lib/agents/director-board";
import { threadMessages, type BoardPayload } from "@/lib/agents/board";

export const dynamic = "force-dynamic";

export async function GET() {
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
    return NextResponse.json({ error: "Only the workspace owner can view the #directors board" }, { status: 403 });
  }

  const rows = await getDirectorBoard(workspaceId);
  const payload: BoardPayload = { posts: threadMessages(rows) };
  return NextResponse.json(payload);
}
