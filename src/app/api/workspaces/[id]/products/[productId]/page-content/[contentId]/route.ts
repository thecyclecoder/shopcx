import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";

const EDITABLE_FIELDS = new Set([
  "hero_headline",
  "hero_subheadline",
  "benefit_bar",
  "mechanism_copy",
  "ingredient_cards",
  "comparison_table_rows",
  "faq_items",
  "guarantee_copy",
  "knowledge_base_article",
  "kb_what_it_doesnt_do",
  "support_macros",
]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string; contentId: string }> },
) {
  const { id: workspaceId, productId, contentId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("product_page_content")
    .select("*")
    .eq("id", contentId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .single();

  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ content: data });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string; contentId: string }> },
) {
  const { id: workspaceId, productId, contentId } = await params;

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

  // Don't allow edits to approved or published content
  const { data: current } = await admin
    .from("product_page_content")
    .select("status")
    .eq("id", contentId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .single();

  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(body)) {
    if (EDITABLE_FIELDS.has(k)) update[k] = v;
  }

  if (Object.keys(update).length === 1) {
    return NextResponse.json({ error: "No editable fields" }, { status: 400 });
  }

  const { error } = await admin
    .from("product_page_content")
    .update(update)
    .eq("id", contentId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Revalidate storefront so edits appear immediately
  try {
    const { data: product } = await admin.from("products").select("handle").eq("id", productId).single();
    const { data: ws } = await admin.from("workspaces").select("storefront_slug").eq("id", workspaceId).single();
    if (product?.handle && ws?.storefront_slug) {
      revalidatePath(`/store/${ws.storefront_slug}/${product.handle}`);
    }
  } catch { /* non-fatal */ }

  return NextResponse.json({ success: true });
}
