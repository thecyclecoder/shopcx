// UPGRADED: Uses our product_reviews table instead of direct Klaviyo API calls

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

function safeStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function normalizeProductId(input: string): string {
  // UUIDs contain hyphens and letters — don't strip them
  if (input.includes("-") && input.length >= 32) return input;
  // Shopify GIDs: gid://shopify/Product/123 → 123
  const parts = input.split("/");
  const last = parts[parts.length - 1] || input;
  return last.replace(/[^\d]/g, "") || last;
}

export const featuredReviews: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

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

  // Map product IDs to product names (for matching reviews with unknown product IDs)
  // Support both Shopify product IDs and internal UUIDs
  const { data: products } = await admin.from("products")
    .select("id, shopify_product_id, title")
    .eq("workspace_id", auth.workspaceId)
    .or(productIds.map(id => `shopify_product_id.eq.${id},id.eq.${id}`).join(","));

  const productNameToId: Record<string, string> = {};
  const internalToShopifyId: Record<string, string> = {};
  for (const p of products || []) {
    if (p.title) productNameToId[p.title.toLowerCase()] = p.shopify_product_id;
    if (p.id && p.shopify_product_id) internalToShopifyId[p.id] = p.shopify_product_id;
    // Ensure byProductId has entries for both ID formats
    // Reviews are keyed by shopify_product_id, but frontend sends internal UUIDs
    if (p.shopify_product_id && !byProductId[p.shopify_product_id]) {
      byProductId[p.shopify_product_id] = { ok: true, reviews: [] };
    }
  }

  // Fetch reviews: try by shopify_product_id first, then by product_name match
  // Columns: featured (not smart_featured), reviewer_name (not author), smart_quote
  // Get Shopify product IDs for the query (resolve from UUIDs if needed)
  const shopifyPids = [...new Set(productIds.map(id => internalToShopifyId[id] || id).filter(Boolean))];
  // Query per product to avoid .in() issues, then merge
  let reviews: { shopify_product_id: string; product_name: string; reviewer_name: string; rating: number; title: string; body: string; summary: string; smart_quote: string; featured: boolean; created_at: string }[] = [];
  for (const spid of shopifyPids) {
    const { data } = await admin.from("product_reviews")
      .select("shopify_product_id, product_name, reviewer_name, rating, title, body, summary, smart_quote, featured, created_at")
      .eq("workspace_id", auth.workspaceId)
      .eq("shopify_product_id", spid)
      .gte("rating", 4)
      .order("featured", { ascending: false })
      .order("rating", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(10);
    if (data) reviews = reviews.concat(data);
  }

  // Match reviews to requested product IDs
  for (const r of reviews || []) {
    // Try direct product ID match
    let pid = r.shopify_product_id && r.shopify_product_id !== "unknown"
      ? r.shopify_product_id
      : null;

    // Fall back to product_name → product ID mapping
    if (!pid && r.product_name) {
      pid = productNameToId[r.product_name.toLowerCase()] || null;
    }

    if (!pid || !byProductId[pid]) continue;
    if (byProductId[pid].reviews.length >= 10) continue;

    // Featured first, then 4+ star
    if (!r.featured && r.rating < 4) continue;

    byProductId[pid].reviews.push({
      rating: r.rating,
      title: r.title || r.smart_quote || "",
      body: r.body || "",
      author: r.reviewer_name || "Verified Customer",
      summary: r.summary || r.smart_quote || r.title || "",
      featured: !!r.featured,
      createdAt: r.created_at,
    });
  }

  // Backfill with 4-star if any product has zero reviews
  for (const r of reviews || []) {
    let pid = r.shopify_product_id && r.shopify_product_id !== "unknown"
      ? r.shopify_product_id
      : null;
    if (!pid && r.product_name) {
      pid = productNameToId[r.product_name.toLowerCase()] || null;
    }
    if (!pid || !byProductId[pid]) continue;
    if (byProductId[pid].reviews.length >= 10) continue;
    if (r.featured || r.rating >= 5) continue; // already added above

    byProductId[pid].reviews.push({
      rating: r.rating,
      title: r.title || r.smart_quote || "",
      body: r.body || "",
      author: r.reviewer_name || "Verified Customer",
      summary: r.summary || r.smart_quote || r.title || "",
      featured: !!r.featured,
      createdAt: r.created_at,
    });
  }

  // Alias: if frontend sent UUIDs, copy Shopify-keyed results to UUID keys
  for (const pid of productIds) {
    if (!byProductId[pid]?.reviews?.length) {
      const shopifyId = internalToShopifyId[pid];
      if (shopifyId && byProductId[shopifyId]?.reviews?.length) {
        byProductId[pid] = byProductId[shopifyId];
      }
    }
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
