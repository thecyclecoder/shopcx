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

  const { data } = await admin
    .from("knowledge_gaps")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .order("ticket_count", { ascending: false });

  return NextResponse.json(data || []);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const body = await request.json();
  const { gap_id, action } = body;

  if (action === "dismiss") {
    await admin
      .from("knowledge_gaps")
      .update({ status: "dismissed" })
      .eq("id", gap_id)
      .eq("workspace_id", workspaceId);
    return NextResponse.json({ ok: true });
  }

  if (action === "create") {
    const { data: gap } = await admin
      .from("knowledge_gaps")
      .select("*")
      .eq("id", gap_id)
      .single();

    if (!gap) return NextResponse.json({ error: "Gap not found" }, { status: 404 });

    // Create KB article from gap
    const { data: article } = await admin
      .from("knowledge_base")
      .insert({
        workspace_id: workspaceId,
        title: gap.suggested_title || gap.topic,
        content: gap.suggested_content || "",
        category: gap.suggested_category || "general",
        active: false,
      })
      .select()
      .single();

    if (article) {
      await admin
        .from("knowledge_gaps")
        .update({ status: "created", created_kb_id: article.id })
        .eq("id", gap_id);
    }

    return NextResponse.json({ ok: true, kb_id: article?.id });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
