import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET — active banned users with their comment counts.
 * Returns each banned user enriched with: total comments in the
 * workspace, hidden comments count, last comment date.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin", "agent", "social"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: banned } = await admin
    .from("banned_meta_users")
    .select("*")
    .eq("workspace_id", workspaceId)
    .is("unbanned_at", null)
    .order("banned_at", { ascending: false });

  // Per-banned-user comment counts. One query per row keeps this
  // simple; banned lists are small (< few hundred).
  const enriched = [];
  for (const b of banned || []) {
    const { count } = await admin
      .from("social_comments")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("meta_sender_id", b.meta_sender_id);
    enriched.push({ ...b, comment_count: count || 0 });
  }

  return NextResponse.json({ banned: enriched });
}
