import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; viewId: string }> }
) {
  const { id: workspaceId, viewId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("name" in body) updates.name = body.name;
  if ("filters" in body) updates.filters = body.filters;
  if ("sort_order" in body) updates.sort_order = body.sort_order;

  const { data: view, error } = await admin
    .from("ticket_views")
    .update(updates)
    .eq("id", viewId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(view);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; viewId: string }> }
) {
  const { id: workspaceId, viewId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  await admin.from("ticket_views").delete().eq("id", viewId).eq("workspace_id", workspaceId);
  return NextResponse.json({ deleted: true });
}
