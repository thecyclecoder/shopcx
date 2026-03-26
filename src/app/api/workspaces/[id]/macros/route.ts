import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: macros } = await admin
    .from("macros")
    .select("id, name, body_text, body_html, category, tags, active, usage_count, gorgias_id, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .order("name", { ascending: true });

  return NextResponse.json(macros || []);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

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
  const { name, body_text, body_html, category, tags } = body;

  if (!name || !body_text) {
    return NextResponse.json({ error: "Name and body_text required" }, { status: 400 });
  }

  const { data: macro, error } = await admin
    .from("macros")
    .insert({
      workspace_id: workspaceId,
      name,
      body_text,
      body_html: body_html || null,
      category: category || null,
      tags: tags || [],
      active: true,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Generate embedding for macro matching
  generateMacroEmbedding(macro.id, name, body_text).catch(() => {});

  return NextResponse.json(macro, { status: 201 });
}

async function generateMacroEmbedding(macroId: string, name: string, bodyText: string) {
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
