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
    .select("id, workspace_id, user_id, role, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at");

  if (error) {
    return NextResponse.json({ error: "Failed to fetch members" }, { status: 500 });
  }

  // Enrich with user info
  const { data: usersData } = await admin.auth.admin.listUsers();
  const usersMap = new Map(
    usersData?.users?.map((u) => [u.id, { email: u.email, display_name: u.user_metadata?.full_name || u.user_metadata?.name }]) ?? []
  );

  const enriched = members?.map((m) => ({
    ...m,
    email: usersMap.get(m.user_id)?.email,
    display_name: usersMap.get(m.user_id)?.display_name,
  }));

  return NextResponse.json(enriched);
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
