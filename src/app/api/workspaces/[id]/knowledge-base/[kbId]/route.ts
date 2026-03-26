import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; kbId: string }> }
) {
  const { id: workspaceId, kbId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: article } = await admin
    .from("knowledge_base")
    .select("*")
    .eq("id", kbId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!article) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { count } = await admin
    .from("kb_chunks")
    .select("id", { count: "exact", head: true })
    .eq("kb_id", kbId);

  return NextResponse.json({ ...article, chunk_count: count || 0 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; kbId: string }> }
) {
  const { id: workspaceId, kbId } = await params;

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
  if (body.title !== undefined) updates.title = body.title;
  if (body.content !== undefined) updates.content = body.content;
  if (body.content_html !== undefined) updates.content_html = body.content_html;
  if (body.category !== undefined) updates.category = body.category;
  if (body.slug !== undefined) updates.slug = body.slug;
  if (body.published !== undefined) updates.published = body.published;
  if (body.product_id !== undefined) updates.product_id = body.product_id;
  if (body.product_name !== undefined) updates.product_name = body.product_name;
  if (body.excerpt !== undefined) updates.excerpt = body.excerpt;
  if (body.active !== undefined) updates.active = body.active;

  const { data: article, error } = await admin
    .from("knowledge_base")
    .update(updates)
    .eq("id", kbId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Re-embed if content changed
  if (body.content !== undefined) {
    await inngest.send({ name: "kb/document.updated", data: { kb_id: kbId, workspace_id: workspaceId } });
  }

  return NextResponse.json(article);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; kbId: string }> }
) {
  const { id: workspaceId, kbId } = await params;
  void request;

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

  await admin.from("knowledge_base").delete().eq("id", kbId).eq("workspace_id", workspaceId);

  return NextResponse.json({ ok: true });
}
