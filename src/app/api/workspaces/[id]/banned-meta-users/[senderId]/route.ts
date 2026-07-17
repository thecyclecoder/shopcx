import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { unbanUser } from "@/lib/social-comment-actions";

/**
 * DELETE — unban a user. Hidden comments stay hidden (no auto-restore;
 * unbanning just removes the future-hide rule). If an agent wants to
 * un-hide specific past comments they do it from the comment detail.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; senderId: string }> },
) {
  const { id: workspaceId, senderId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await unbanUser(workspaceId, senderId, user.id);
  return NextResponse.json({ ok: true });
}
