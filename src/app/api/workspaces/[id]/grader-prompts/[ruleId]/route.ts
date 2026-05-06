import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// PATCH — approve / reject / edit a grader rule
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; ruleId: string }> }) {
  const { id: workspaceId, ruleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body?.title === "string") updates.title = body.title.trim();
  if (typeof body?.content === "string") updates.content = body.content.trim();
  if (typeof body?.sort_order === "number") updates.sort_order = body.sort_order;
  if (typeof body?.status === "string") {
    if (!["proposed", "approved", "rejected", "archived"].includes(body.status)) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    updates.status = body.status;
    updates.reviewed_at = new Date().toISOString();
    updates.reviewed_by = user.id;
  }

  const { data, error } = await admin.from("grader_prompts")
    .update(updates)
    .eq("id", ruleId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rule: data });
}

// DELETE — hard delete (admin only)
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; ruleId: string }> }) {
  const { id: workspaceId, ruleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { error } = await admin.from("grader_prompts")
    .delete()
    .eq("id", ruleId)
    .eq("workspace_id", workspaceId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
