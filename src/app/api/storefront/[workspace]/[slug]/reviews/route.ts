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
  const idsParam = url.searchParams.get("ids");
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "12", 10)));

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

  // Linked-product pool — reviews follow the format group (Instant ↔
  // K-Cups), so the pill matches map and "load more" both serve the
  // pooled set, not just this product's.
  const { data: linkMembership } = await admin
    .from("product_link_members")
    .select("group_id")
    .eq("product_id", product.id)
    .limit(1)
    .maybeSingle();
  let productIds: string[] = [product.id];
  if (linkMembership?.group_id) {
    const { data: siblings } = await admin
      .from("product_link_members")
      .select("product_id")
      .eq("group_id", linkMembership.group_id);
    productIds = Array.from(
      new Set([product.id, ...(siblings || []).map((s) => s.product_id)]),
    );
  }

  const reviewSelect =
    "id, reviewer_name, rating, title, body, images, smart_quote, created_at, status, featured, product_id";

  // ID-list mode: lazy-fetch specific reviews (used by pill clicks
  // when matched IDs aren't already in the loaded set).
  if (idsParam) {
    const ids = idsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100); // safety cap
    if (ids.length === 0) {
      return NextResponse.json({ reviews: [], total: 0, has_more: false });
    }
    const { data: reviews } = await admin
      .from("product_reviews")
      .select(reviewSelect)
      .eq("workspace_id", workspace.id)
      .in("product_id", productIds)
      .in("id", ids)
      .in("status", ["published", "featured"])
      .not("body", "is", null)
      .order("featured", { ascending: false })
      .order("rating", { ascending: false })
      .order("created_at", { ascending: false });
    return NextResponse.json(
      { reviews: reviews || [], total: ids.length, has_more: false },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  }

  const [{ data: reviews }, { count }] = await Promise.all([
    admin
      .from("product_reviews")
      .select(reviewSelect)
      .eq("workspace_id", workspace.id)
      .in("product_id", productIds)
      .in("status", ["published", "featured"])
      .not("body", "is", null)
      .order("featured", { ascending: false })
      .order("rating", { ascending: false })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1),
    admin
      .from("product_reviews")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .in("product_id", productIds)
      .in("status", ["published", "featured"])
      .not("body", "is", null),
  ]);

  const total = count || 0;
  const returned = reviews || [];

  return NextResponse.json(
    {
      reviews: returned,
      total,
      has_more: offset + returned.length < total,
    },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
  );
}
