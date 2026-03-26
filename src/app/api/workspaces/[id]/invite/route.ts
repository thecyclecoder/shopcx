import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendInviteEmail } from "@/lib/email";
import type { WorkspaceRole } from "@/lib/types/workspace";

const VALID_ROLES: WorkspaceRole[] = ["admin", "agent", "social", "marketing", "read_only"];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Check caller is owner or admin of this workspace
  const { data: callerMember } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!callerMember || !["owner", "admin"].includes(callerMember.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { email, role } = body;

  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  if (!role || !VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  // Check if already a member
  const { data: existingUsers } = await admin.auth.admin.listUsers();
  const existingUser = existingUsers?.users?.find(
    (u) => u.email?.toLowerCase() === email.toLowerCase()
  );

  if (existingUser) {
    const { data: existingMember } = await admin
      .from("workspace_members")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", existingUser.id)
      .single();

    if (existingMember) {
      return NextResponse.json({ error: "User is already a member" }, { status: 409 });
    }
  }

  // Create invite
  const { data: invite, error } = await admin
    .from("workspace_invites")
    .insert({
      workspace_id: workspaceId,
      email: email.toLowerCase(),
      role,
      invited_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: "Failed to create invite" }, { status: 500 });
  }

  // Get workspace name for the email
  const { data: workspace } = await admin
    .from("workspaces")
    .select("name")
    .eq("id", workspaceId)
    .single();

  // Send invite email (best-effort, don't fail the invite if email fails)
  const emailResult = await sendInviteEmail({
    workspaceId,
    workspaceName: workspace?.name || "ShopCX.ai",
    toEmail: email.toLowerCase(),
    role,
    invitedByName: user.user_metadata?.full_name || user.email || "A team member",
  });

  return NextResponse.json(
    { ...invite, email_sent: !emailResult.error, email_error: emailResult.error },
    { status: 201 }
  );
}
