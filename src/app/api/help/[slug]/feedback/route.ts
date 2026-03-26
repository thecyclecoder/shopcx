import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// POST: Record article helpful vote (no auth — public)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json();
  const { article_id, vote } = body;

  if (!article_id || !["up", "down"].includes(vote)) {
    return NextResponse.json({ error: "article_id and vote (up/down) required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify workspace exists
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id")
    .eq("help_slug", slug)
    .single();

  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get current counts
  const { data: article } = await admin
    .from("knowledge_base")
    .select("helpful_yes, helpful_no")
    .eq("id", article_id)
    .eq("workspace_id", workspace.id)
    .single();

  if (!article) return NextResponse.json({ error: "Article not found" }, { status: 404 });

  const field = vote === "up" ? "helpful_yes" : "helpful_no";
  await admin
    .from("knowledge_base")
    .update({ [field]: (article[field] || 0) + 1 })
    .eq("id", article_id);

  return NextResponse.json({ ok: true });
}
