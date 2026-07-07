import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
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

  // Verify caller is a member
  const { data: callerMember } = await admin
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!callerMember) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Get members
  const { data: members, error } = await admin
    .from("workspace_members")
    .select("id, workspace_id, user_id, role, display_name, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at");

  if (error) {
    return NextResponse.json({ error: "Failed to fetch members" }, { status: 500 });
  }

  // Enrich with user email — workspace_members.display_name is already selected
  // above (the canonical user-facing name), and workspace_members has no email
  // column, so getUserById per member (targeted, no auth.users scan).
  const memberIds = (members ?? []).map((m) => m.user_id);
  const emailByUser = new Map<string, string | null>();
  await Promise.all(
    memberIds.map(async (uid) => {
      const { data } = await admin.auth.admin.getUserById(uid);
      emailByUser.set(uid, data.user?.email ?? null);
    }),
  );

  const enriched = members?.map((m) => ({
    ...m,
    email: emailByUser.get(m.user_id) ?? null,
    display_name: m.display_name || null,
  }));

  return NextResponse.json(enriched);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();
  const { user_id, display_name } = body;

  const targetUserId = user_id || user.id;

  // Users can edit their own display_name, or admins/owners can edit anyone's
  if (targetUserId !== user.id) {
    const { data: caller } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .single();
    if (!caller || !["owner", "admin"].includes(caller.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  await admin
    .from("workspace_members")
    .update({ display_name: display_name || null })
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId);

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Verify caller is owner or admin
  const { data: caller } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!caller || !["owner", "admin"].includes(caller.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { user_id } = body;
  if (!user_id) return NextResponse.json({ error: "user_id required" }, { status: 400 });

  // Can't remove yourself
  if (user_id === user.id) {
    return NextResponse.json({ error: "Cannot remove yourself" }, { status: 400 });
  }

  // Can't remove the owner
  const { data: target } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user_id)
    .single();

  if (!target) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  if (target.role === "owner") {
    return NextResponse.json({ error: "Cannot remove the workspace owner" }, { status: 403 });
  }

  await admin
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", user_id);

  return NextResponse.json({ removed: true });
}
