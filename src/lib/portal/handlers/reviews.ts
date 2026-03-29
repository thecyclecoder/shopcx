// UPGRADED: Uses our product_reviews table instead of direct Klaviyo API calls

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

function safeStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function normalizeProductId(input: string): string {
  const parts = input.split("/");
  const last = parts[parts.length - 1] || input;
  return last.replace(/[^\d]/g, "") || last;
}

export const featuredReviews: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const rawIds = safeStr(url.searchParams.get("productIds")) || safeStr(url.searchParams.get("ids"));
  if (!rawIds) return jsonErr({ error: "missing_product_ids" }, 400);

  const productIds = [...new Set(rawIds.split(",").map(s => normalizeProductId(s.trim())).filter(Boolean))];
  if (!productIds.length) return jsonErr({ error: "missing_product_ids" }, 400);
  if (productIds.length > 50) return jsonErr({ error: "too_many_product_ids", max: 50 }, 400);

  const admin = createAdminClient();
  const byProductId: Record<string, { ok: boolean; reviews: unknown[] }> = {};

  for (const pid of productIds) {
    byProductId[pid] = { ok: true, reviews: [] };
  }

  // Fetch featured reviews first, then 5-star as fallback
  // Priority: smart_featured=true → 5-star → 4-star
  const { data: reviews } = await admin.from("product_reviews")
    .select("shopify_product_id, author, rating, title, body, summary, smart_featured, created_at")
    .eq("workspace_id", auth.workspaceId)
    .in("shopify_product_id", productIds)
    .gte("rating", 4)
    .order("smart_featured", { ascending: false })
    .order("rating", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(productIds.length * 10);

  // Group by product: featured first, then 5-star, cap at 5 per product
  for (const r of reviews || []) {
    const pid = r.shopify_product_id;
    if (!pid || !byProductId[pid]) continue;
    if (byProductId[pid].reviews.length >= 5) continue;

    // Only include featured or 5-star reviews
    if (!r.smart_featured && r.rating < 5) continue;

    byProductId[pid].reviews.push({
      rating: r.rating,
      title: r.title,
      body: r.body,
      author: r.author,
      summary: r.summary,
      featured: r.smart_featured,
      createdAt: r.created_at,
    });
  }

  // If any product has zero reviews after filtering, backfill with 4-star
  for (const r of reviews || []) {
    const pid = r.shopify_product_id;
    if (!pid || !byProductId[pid]) continue;
    if (byProductId[pid].reviews.length >= 3) continue;
    // Already added above if featured or 5-star; only add 4-star as last resort
    if (r.smart_featured || r.rating >= 5) continue;
    byProductId[pid].reviews.push({
      rating: r.rating,
      title: r.title,
      body: r.body,
      author: r.author,
      summary: r.summary,
      featured: r.smart_featured,
      createdAt: r.created_at,
    });
  }

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    product_ids: productIds,
    by_product_id: byProductId,
  });
};
