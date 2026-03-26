import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: Public help center data — no auth required
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search");
  const category = searchParams.get("category");

  const admin = createAdminClient();

  // Find workspace by help slug
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name, help_slug")
    .eq("help_slug", slug)
    .single();

  if (!workspace) return NextResponse.json({ error: "Help center not found" }, { status: 404 });

  // Get published articles
  let query = admin
    .from("knowledge_base")
    .select("id, title, slug, category, excerpt, product_name, product_id, created_at, updated_at")
    .eq("workspace_id", workspace.id)
    .eq("published", true)
    .eq("active", true)
    .order("title");

  if (category) query = query.eq("category", category);
  if (search) query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%`);

  const { data: articles } = await query;

  // Get unique categories with counts
  const categories: Record<string, number> = {};
  for (const a of articles || []) {
    categories[a.category] = (categories[a.category] || 0) + 1;
  }

  // Get products referenced by articles
  const productIds = [...new Set((articles || []).filter(a => a.product_id).map(a => a.product_id))];
  let products: { id: string; title: string; image_url: string | null }[] = [];
  if (productIds.length > 0) {
    const { data } = await admin.from("products").select("id, title, image_url").in("id", productIds);
    products = data || [];
  }

  return NextResponse.json({
    workspace_name: workspace.name,
    articles: articles || [],
    categories,
    products,
  });
}
