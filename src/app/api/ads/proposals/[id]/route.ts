import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const workspaceId: string | undefined = body.workspaceId;
  const status: string | undefined = body.status;

  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  if (status !== "rejected" && status !== "archived")
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: proposal } = await admin
    .from("ad_avatar_proposals")
    .select("id, workspace_id")
    .eq("id", id)
    .single();
  if (!proposal || proposal.workspace_id !== workspaceId)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { error } = await admin
    .from("ad_avatar_proposals")
    .update({ status })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
