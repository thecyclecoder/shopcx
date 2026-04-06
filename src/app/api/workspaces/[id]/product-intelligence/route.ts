import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: List product intelligence entries
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const search = request.nextUrl.searchParams.get("search") || "";

  let query = admin.from("product_intelligence")
    .select(`
      id, workspace_id, product_id, title, source, source_urls, created_at, updated_at,
      products(id, title, image_url, shopify_product_id)
    `, { count: "exact" })
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false });

  if (search) {
    query = query.ilike("title", `%${search}%`);
  }

  const { data, count, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ items: data || [], total: count || 0 });
}

// POST: Create product intelligence
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();
  const { product_id, title, content, source } = body as {
    product_id: string; title: string; content: string; source?: string;
  };

  if (!product_id || !content) {
    return NextResponse.json({ error: "product_id and content required" }, { status: 400 });
  }

  // Check for existing (one per product)
  const { data: existing } = await admin.from("product_intelligence")
    .select("id").eq("workspace_id", workspaceId).eq("product_id", product_id).single();

  if (existing) {
    return NextResponse.json({ error: "Product intelligence already exists for this product. Use PATCH to update." }, { status: 409 });
  }

  const { data, error } = await admin.from("product_intelligence").insert({
    workspace_id: workspaceId,
    product_id,
    title: title || "Untitled",
    content,
    source: source || "manual",
  }).select("id").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}
