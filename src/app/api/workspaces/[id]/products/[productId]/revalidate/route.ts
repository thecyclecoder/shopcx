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

  const paths: string[] = [];
  if (ws?.storefront_slug) {
    revalidatePath(`/store/${ws.storefront_slug}/${product.handle}`);
    paths.push(`/store/${ws.storefront_slug}/${product.handle}`);
  }
  revalidatePath(`/${product.handle}`);
  paths.push(`/${product.handle}`);

  return NextResponse.json({ ok: true, paths });
}
