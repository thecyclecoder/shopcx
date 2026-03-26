import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

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

  const { data: articles } = await admin
    .from("knowledge_base")
    .select("*, kb_chunks(count)")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false });

  // Flatten chunk count
  const enriched = (articles || []).map((a) => ({
    ...a,
    chunk_count: (a.kb_chunks as unknown as { count: number }[])?.[0]?.count || 0,
    kb_chunks: undefined,
  }));

  return NextResponse.json(enriched);
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

  // Verify admin/owner role
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
  const { title, content, category, active } = body;

  if (!title || !content || !category) {
    return NextResponse.json({ error: "Title, content, and category required" }, { status: 400 });
  }

  const { data: article, error } = await admin
    .from("knowledge_base")
    .insert({ workspace_id: workspaceId, title, content, category, active: active ?? true })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Trigger embedding pipeline
  await inngest.send({ name: "kb/document.updated", data: { kb_id: article.id, workspace_id: workspaceId } });

  return NextResponse.json(article, { status: 201 });
}
