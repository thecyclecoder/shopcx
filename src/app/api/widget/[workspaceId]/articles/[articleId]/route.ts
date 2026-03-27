import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: Single article content for inline widget display — no auth
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string; articleId: string }> }
) {
  const { workspaceId, articleId } = await params;
  void request;

  const admin = createAdminClient();

  const { data: article } = await admin
    .from("knowledge_base")
    .select("id, title, content, content_html, excerpt, category, product_name")
    .eq("id", articleId)
    .eq("workspace_id", workspaceId)
    .eq("published", true)
    .single();

  if (!article) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Increment view count
  admin.from("knowledge_base").update({ view_count: (article as { view_count?: number }).view_count || 0 + 1 }).eq("id", articleId).then(() => {});

  return NextResponse.json(article);
}
