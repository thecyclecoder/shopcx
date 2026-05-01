import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceBySlug } from "@/app/(storefront)/_lib/page-data";

/**
 * Paginated reviews endpoint for the "load more" button on the
 * storefront. Public — no auth. Only returns published / featured
 * reviews with a non-empty body.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspace: string; slug: string }> },
) {
  const { workspace: workspaceSlug, slug } = await params;
  const url = new URL(request.url);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
  const limit = Math.min(24, Math.max(1, parseInt(url.searchParams.get("limit") || "12", 10)));

  const workspace = await getWorkspaceBySlug(workspaceSlug);
  if (!workspace) {
    return NextResponse.json({ reviews: [], total: 0, has_more: false }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data: product } = await admin
    .from("products")
    .select("id")
    .eq("workspace_id", workspace.id)
    .eq("handle", slug)
    .maybeSingle();

  if (!product?.id) {
    return NextResponse.json({ reviews: [], total: 0, has_more: false });
  }

  const [{ data: reviews }, { count }] = await Promise.all([
    admin
      .from("product_reviews")
      .select(
        "id, reviewer_name, rating, title, body, images, smart_quote, created_at, status",
      )
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .in("status", ["published", "featured"])
      .not("body", "is", null)
      .order("rating", { ascending: false })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1),
    admin
      .from("product_reviews")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .in("status", ["published", "featured"])
      .not("body", "is", null),
  ]);

  const total = count || 0;
  const returned = reviews || [];

  return NextResponse.json({
    reviews: returned,
    total,
    has_more: offset + returned.length < total,
  });
}
