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

  // Resolve every incoming ID (Shopify ID or internal UUID) to the
  // internal product UUID. Reviews join on `product_id` now.
  const { data: products } = await admin.from("products")
    .select("id, shopify_product_id")
    .eq("workspace_id", auth.workspaceId)
    .or(productIds.map(id => `shopify_product_id.eq.${id},id.eq.${id}`).join(","));

  const incomingToInternal: Record<string, string> = {};
  for (const p of products || []) {
    if (p.id) {
      incomingToInternal[p.id] = p.id;
      if (p.shopify_product_id) incomingToInternal[p.shopify_product_id] = p.id;
    }
  }

  // Initialize response keyed by whatever the caller sent so we don't
  // surprise existing portal/widget code.
  const byProductId: Record<string, { ok: boolean; reviews: unknown[] }> = {};
  for (const pid of productIds) byProductId[pid] = { ok: true, reviews: [] };

  const internalIds = [...new Set(Object.values(incomingToInternal))];
  if (!internalIds.length) {
    return jsonOk({
      ok: true,
      shop: auth.shop,
      logged_in_customer_id: auth.loggedInCustomerId,
      route,
      product_ids: productIds,
      by_product_id: byProductId,
    });
  }

  const { data: reviews } = await admin.from("product_reviews")
    .select("product_id, reviewer_name, rating, title, body, summary, smart_quote, featured, created_at")
    .eq("workspace_id", auth.workspaceId)
    .in("product_id", internalIds)
    .gte("rating", 4)
    .order("featured", { ascending: false })
    .order("rating", { ascending: false })
    .order("created_at", { ascending: false });

  // Bucket reviews by internal product_id, capped at 10 per product.
  // First pass takes featured + 5-star; second pass backfills 4-star.
  const bucketed: Record<string, unknown[]> = {};
  for (const id of internalIds) bucketed[id] = [];

  for (const r of reviews || []) {
    if (!r.product_id || !bucketed[r.product_id]) continue;
    if (bucketed[r.product_id].length >= 10) continue;
    if (!r.featured && r.rating < 5) continue;
    bucketed[r.product_id].push({
      rating: r.rating,
      title: r.title || r.smart_quote || "",
      body: r.body || "",
      author: r.reviewer_name || "Verified Customer",
      summary: r.summary || r.smart_quote || r.title || "",
      featured: !!r.featured,
      createdAt: r.created_at,
    });
  }
  for (const r of reviews || []) {
    if (!r.product_id || !bucketed[r.product_id]) continue;
    if (bucketed[r.product_id].length >= 10) continue;
    if (r.featured || r.rating >= 5) continue;
    bucketed[r.product_id].push({
      rating: r.rating,
      title: r.title || r.smart_quote || "",
      body: r.body || "",
      author: r.reviewer_name || "Verified Customer",
      summary: r.summary || r.smart_quote || r.title || "",
      featured: !!r.featured,
      createdAt: r.created_at,
    });
  }

  // Map results back to whatever ID format the caller sent.
  for (const pid of productIds) {
    const internalId = incomingToInternal[pid];
    if (internalId && bucketed[internalId]) {
      byProductId[pid] = { ok: true, reviews: bucketed[internalId] };
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
