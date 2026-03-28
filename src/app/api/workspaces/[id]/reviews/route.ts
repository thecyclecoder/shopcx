import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
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

  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const reviewType = url.searchParams.get("review_type");
  const productId = url.searchParams.get("product_id");
  const customerId = url.searchParams.get("customer_id");
  const search = url.searchParams.get("search");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  let query = admin
    .from("product_reviews")
    .select("id, klaviyo_review_id, shopify_product_id, product_name, reviewer_name, email, rating, title, body, summary, smart_quote, review_type, status, featured, verified_purchase, images, customer_id, published_at, updated_at, created_at", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .order("published_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);
  if (reviewType) query = query.eq("review_type", reviewType);
  if (productId) query = query.eq("shopify_product_id", productId);
  if (customerId) query = query.eq("customer_id", customerId);
  if (search) query = query.or(`title.ilike.%${search}%,body.ilike.%${search}%,reviewer_name.ilike.%${search}%`);

  const { data: reviews, count, error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Get stats
  const [
    { count: totalCount },
    { count: publishedCount },
    { count: pendingCount },
    { count: featuredCount },
    { count: rejectedCount },
  ] = await Promise.all([
    admin.from("product_reviews").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
    admin.from("product_reviews").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "published"),
    admin.from("product_reviews").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "pending"),
    admin.from("product_reviews").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "featured"),
    admin.from("product_reviews").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "rejected"),
  ]);

  return NextResponse.json({
    reviews: reviews || [],
    total: count || 0,
    stats: {
      total: totalCount || 0,
      published: publishedCount || 0,
      pending: pendingCount || 0,
      featured: featuredCount || 0,
      rejected: rejectedCount || 0,
    },
  });
}
