import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; patternId: string }> }
) {
  const { id: workspaceId, patternId } = await params;

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

  // Only allow editing workspace patterns (not global)
  const { data: existing } = await admin.from("smart_patterns").select("workspace_id").eq("id", patternId).single();
  if (!existing?.workspace_id) {
    return NextResponse.json({ error: "Cannot edit global patterns" }, { status: 403 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};
  if ("name" in body) updates.name = body.name;
  if ("category" in body) updates.category = body.category;
  if ("phrases" in body) updates.phrases = body.phrases;
  if ("match_target" in body) updates.match_target = body.match_target;
  if ("priority" in body) updates.priority = body.priority;
  if ("auto_tag" in body) updates.auto_tag = body.auto_tag;
  if ("auto_action" in body) updates.auto_action = body.auto_action;
  if ("active" in body) updates.active = body.active;

  const { data: pattern, error } = await admin
    .from("smart_patterns")
    .update(updates)
    .eq("id", patternId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(pattern);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; patternId: string }> }
) {
  const { id: workspaceId, patternId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Only allow deleting workspace patterns
  const { data: existing } = await admin.from("smart_patterns").select("workspace_id").eq("id", patternId).single();
  if (!existing?.workspace_id) {
    return NextResponse.json({ error: "Cannot delete global patterns — dismiss instead" }, { status: 403 });
  }

  await admin.from("smart_patterns").delete().eq("id", patternId).eq("workspace_id", workspaceId);
  return NextResponse.json({ deleted: true });
}
