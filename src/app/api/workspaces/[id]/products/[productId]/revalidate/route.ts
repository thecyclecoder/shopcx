import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST: revalidate the storefront PDP for this product. Catches both URL
 * shapes — the public custom-domain shape (/{slug}) and the admin preview
 * (/store/{workspace_slug}/{handle}) — without callers having to know
 * which they want.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [{ data: product }, { data: ws }] = await Promise.all([
    admin.from("products").select("handle").eq("id", productId).eq("workspace_id", workspaceId).single(),
    admin.from("workspaces").select("storefront_slug").eq("id", workspaceId).single(),
  ]);
  if (!product?.handle) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  // Cascade to link-group siblings — see media route's
  // revalidateProductAndLinkedSiblings for the rationale.
  const ids = new Set<string>([productId]);
  const { data: groups } = await admin
    .from("product_link_members").select("group_id").eq("product_id", productId);
  const groupIds = (groups || []).map(g => g.group_id);
  if (groupIds.length) {
    const { data: siblings } = await admin
      .from("product_link_members").select("product_id").in("group_id", groupIds);
    for (const s of siblings || []) ids.add(s.product_id as string);
  }
  const { data: products } = await admin
    .from("products").select("handle").in("id", Array.from(ids)).eq("workspace_id", workspaceId);

  const paths: string[] = [];
  for (const p of products || []) {
    if (!p.handle) continue;
    if (ws?.storefront_slug) {
      revalidatePath(`/store/${ws.storefront_slug}/${p.handle}`);
      paths.push(`/store/${ws.storefront_slug}/${p.handle}`);
    }
    revalidatePath(`/${p.handle}`);
    paths.push(`/${p.handle}`);
  }

  return NextResponse.json({ ok: true, paths });
}
