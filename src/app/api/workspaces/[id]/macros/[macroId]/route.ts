import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; macroId: string }> }
) {
  const { id: workspaceId, macroId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: macro, error } = await admin
    .from("macros")
    .select("id, name, body_text, body_html, category, tags, active, usage_count, gorgias_id, ai_suggest_count, ai_accept_count, ai_reject_count, ai_edit_count, created_at, updated_at")
    .eq("id", macroId)
    .eq("workspace_id", workspaceId)
    .single();

  if (error || !macro) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(macro);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; macroId: string }> }
) {
  const { id: workspaceId, macroId } = await params;

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
  if (body.name !== undefined) updates.name = body.name;
  if (body.body_text !== undefined) updates.body_text = body.body_text;
  if (body.body_html !== undefined) updates.body_html = body.body_html;
  if (body.category !== undefined) updates.category = body.category;
  if (body.tags !== undefined) updates.tags = body.tags;
  if (body.active !== undefined) updates.active = body.active;

  const { data: macro, error } = await admin
    .from("macros")
    .update(updates)
    .eq("id", macroId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Re-embed if content changed
  if (body.name !== undefined || body.body_text !== undefined) {
    reEmbed(macroId, macro.name, macro.body_text).catch(() => {});
  }

  return NextResponse.json(macro);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; macroId: string }> }
) {
  const { id: workspaceId, macroId } = await params;
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

  await admin.from("macros").delete().eq("id", macroId).eq("workspace_id", workspaceId);
  return NextResponse.json({ ok: true });
}

async function reEmbed(macroId: string, name: string, bodyText: string) {
  const { generateEmbedding1536 } = await import("@/lib/embeddings");
  const { createAdminClient: createAdmin } = await import("@/lib/supabase/admin");
  const admin = createAdmin();

  const text = `${name}. ${bodyText}`.slice(0, 2000);
  const embedding = await generateEmbedding1536(text);
  if (embedding) {
    await admin
      .from("macros")
      .update({ embedding: JSON.stringify(embedding), embedding_text: text })
      .eq("id", macroId);
  }
}
