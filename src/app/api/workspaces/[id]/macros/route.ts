import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const url = new URL(request.url);

  const search = url.searchParams.get("search");
  const category = url.searchParams.get("category");
  const active = url.searchParams.get("active"); // "true", "false", or null for all
  const sort = url.searchParams.get("sort") || "name";
  const order = url.searchParams.get("order") || "asc";
  const limit = parseInt(url.searchParams.get("limit") || "0");
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const selectCols = "id, name, body_text, body_html, category, tags, active, usage_count, gorgias_id, ai_suggest_count, ai_accept_count, ai_reject_count, ai_edit_count, created_at, updated_at";

  let query = admin
    .from("macros")
    .select(selectCols, limit > 0 ? { count: "exact" } : undefined)
    .eq("workspace_id", workspaceId);

  if (category && category !== "all") {
    query = query.eq("category", category);
  }

  if (active === "true") query = query.eq("active", true);
  else if (active === "false") query = query.eq("active", false);

  const productId = searchParams.get("product_id");
  if (productId && productId !== "all") {
    query = query.eq("product_id", productId);
  }

  if (search) {
    query = query.or(`name.ilike.%${search}%,body_text.ilike.%${search}%,category.ilike.%${search}%`);
  }

  // Sorting
  const ascending = order === "asc";
  query = query.order(sort, { ascending });

  // Pagination (only when limit > 0, for backwards compatibility)
  if (limit > 0) {
    query = query.range(offset, offset + limit - 1);
  }

  const { data: macros, count } = await query;

  // If paginated request, return object with total
  if (limit > 0) {
    return NextResponse.json({ macros: macros || [], total: count || 0 });
  }

  // Legacy: return flat array for settings page compatibility
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
