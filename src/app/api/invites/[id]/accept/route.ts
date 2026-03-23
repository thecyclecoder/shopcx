import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: inviteId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Fetch invite
  const { data: invite } = await admin
    .from("workspace_invites")
    .select("*")
    .eq("id", inviteId)
    .is("accepted_at", null)
    .single();

  if (!invite) {
    return NextResponse.json({ error: "Invite not found or already accepted" }, { status: 404 });
  }

  // Verify email matches
  if (invite.email.toLowerCase() !== user.email?.toLowerCase()) {
    return NextResponse.json({ error: "Invite is for a different email" }, { status: 403 });
  }

  // Check not expired
  if (new Date(invite.expires_at) < new Date()) {
    return NextResponse.json({ error: "Invite has expired" }, { status: 410 });
  }

  // Create membership
  const { error: memberError } = await admin.from("workspace_members").upsert(
    {
      workspace_id: invite.workspace_id,
      user_id: user.id,
      role: invite.role,
    },
    { onConflict: "workspace_id,user_id" }
  );

  if (memberError) {
    return NextResponse.json({ error: "Failed to join workspace" }, { status: 500 });
  }

  // Mark accepted
  await admin
    .from("workspace_invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", inviteId);

  return NextResponse.json({ success: true, workspace_id: invite.workspace_id });
}
