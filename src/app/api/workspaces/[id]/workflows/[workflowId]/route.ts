import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; workflowId: string }> }
) {
  const { id: workspaceId, workflowId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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

  const body = await request.json();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("name" in body) updates.name = body.name;
  if ("enabled" in body) updates.enabled = body.enabled;
  if ("config" in body) updates.config = body.config;
  if ("trigger_tag" in body) updates.trigger_tag = body.trigger_tag;

  const { data: workflow, error } = await admin
    .from("workflows")
    .update(updates)
    .eq("id", workflowId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(workflow);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; workflowId: string }> }
) {
  const { id: workspaceId, workflowId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  await admin.from("workflows").delete().eq("id", workflowId).eq("workspace_id", workspaceId);
  return NextResponse.json({ deleted: true });
}
