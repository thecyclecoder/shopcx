/**
 * Klaviyo API client — reviews sync, management, and retrieval.
 *
 * Klaviyo Reviews API fields (from actual API docs):
 * - review_type: "review" | "question" | "rating" | "store"
 * - status.value: "published" | "unpublished" | "pending" | "featured" | "rejected"
 * - product.external_id: Shopify product ID (often null)
 * - relationships.item.data.id: "$shopify:::$default:::{product_id}" (reliable source)
 * - smart_quote: AI-extracted excerpt
 * - email: reviewer email (server API only)
 * - images: array of image URLs
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { HAIKU_MODEL } from "@/lib/ai-models";

/**
 * Extract Shopify product ID from Klaviyo review relationships.
 * Klaviyo stores it as: relationships.item.data.id = "$shopify:::$default:::7467749965997"
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractShopifyProductId(review: any): string | null {
  try {
    const catalogId = review?.relationships?.item?.data?.id;
    if (typeof catalogId !== "string") return null;
    // Format: $shopify:::$default:::PRODUCT_ID
    const parts = catalogId.split(":::");
    const lastPart = parts[parts.length - 1];
    if (lastPart && /^\d+$/.test(lastPart)) return lastPart;
    return null;
  } catch {
    return null;
  }
}

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const KLAVIYO_REVISION = "2025-01-15";

interface KlaviyoReviewAttributes {
  email?: string;
  status?: { value: string; rejection_reason?: { reason: string; status_explanation?: string } };
  verified: boolean;
  review_type: "review" | "question" | "rating" | "store";
  created: string;
  updated: string;
  images: string[];
  product?: { url: string; name: string; image_url?: string; external_id?: string };
  rating: number | null;
  author?: string;
  content?: string;
  title?: string;
  smart_quote?: string;
  public_reply?: { content: string; author: string; updated: string };
}

interface KlaviyoReview {
  type: string;
  id: string;
  attributes: KlaviyoReviewAttributes;
}

interface KlaviyoListResponse {
  data: KlaviyoReview[];
  links?: { self?: string; next?: string; prev?: string };
}

async function getKlaviyoCredentials(workspaceId: string): Promise<{ apiKey: string; publicKey: string | null } | null> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("klaviyo_api_key_encrypted, klaviyo_public_key")
    .eq("id", workspaceId)
    .single();

  if (!ws?.klaviyo_api_key_encrypted) return null;

  return {
    apiKey: decrypt(ws.klaviyo_api_key_encrypted),
    publicKey: ws.klaviyo_public_key,
  };
}

function klaviyoHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_REVISION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// ── Fetch reviews from Klaviyo ──

export async function fetchKlaviyoReviews(
  workspaceId: string,
  options?: { sinceDate?: string },
): Promise<KlaviyoReview[]> {
  const creds = await getKlaviyoCredentials(workspaceId);
  if (!creds) return [];

  const allReviews: KlaviyoReview[] = [];

  // Build filter — if sinceDate provided, only pull reviews created after that date
  let filter = "";
  if (options?.sinceDate) {
    filter = `&filter=greater-or-equal(created,${options.sinceDate})`;
  }

  let url: string | null = `${KLAVIYO_BASE}/reviews/?page[size]=100&sort=-created${filter}`;

  while (url) {
    const res: Response = await fetch(url, { headers: klaviyoHeaders(creds.apiKey) });

    if (!res.ok) {
      console.error(`Klaviyo reviews fetch failed: ${res.status}`);
      break;
    }

    const data: KlaviyoListResponse = await res.json();
    allReviews.push(...(data.data || []));
    url = data.links?.next || null;
  }

  return allReviews;
}

// ── Sync one page of reviews (batch of 100: fetch → match customers → upsert) ──

export function buildSyncUrl(options?: { fullSync?: boolean }): string {
  const sinceDate = options?.fullSync
    ? undefined
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let filter = "";
  if (sinceDate) {
    filter = `&filter=greater-or-equal(created,${sinceDate})`;
  }
  return `${KLAVIYO_BASE}/reviews/?page[size]=100&sort=-created${filter}`;
}

export async function syncReviewPage(
  workspaceId: string,
  pageUrl: string,
): Promise<{ synced: number; errors: number; nextUrl: string | null }> {
  const creds = await getKlaviyoCredentials(workspaceId);
  if (!creds) return { synced: 0, errors: 0, nextUrl: null };

  const admin = createAdminClient();

  const res: Response = await fetch(pageUrl, { headers: klaviyoHeaders(creds.apiKey) });
  if (!res.ok) {
    console.error(`Klaviyo reviews fetch failed: ${res.status}`);
    return { synced: 0, errors: 0, nextUrl: null };
  }

  const data: KlaviyoListResponse = await res.json();
  const batch = data.data || [];
  if (batch.length === 0) return { synced: 0, errors: 0, nextUrl: null };

  // Step 1: Collect unique emails for batch customer lookup
  const emails = [...new Set(batch.map(r => r.attributes.email).filter(Boolean))] as string[];

  // Step 2: Batch lookup customers by email
  const customerMap = new Map<string, string>();
  if (emails.length > 0) {
    const { data: customers } = await admin
      .from("customers")
      .select("id, email")
      .eq("workspace_id", workspaceId)
      .in("email", emails);

    for (const c of customers || []) {
      if (c.email) customerMap.set(c.email.toLowerCase(), c.id);
    }
  }

  // Step 2b: Resolve internal product UUIDs from the Shopify IDs Klaviyo
  // gives us. Reviews join on `products.id`; `shopify_product_id` is
  // sync-only metadata.
  const shopifyProductIds = [...new Set(
    batch.map(r => extractShopifyProductId(r) || r.attributes.product?.external_id || "")
      .filter(s => s && s !== "unknown"),
  )];
  const productIdMap = new Map<string, string>();
  if (shopifyProductIds.length > 0) {
    const { data: products } = await admin
      .from("products")
      .select("id, shopify_product_id")
      .eq("workspace_id", workspaceId)
      .in("shopify_product_id", shopifyProductIds);
    for (const p of products || []) {
      if (p.shopify_product_id && p.id) productIdMap.set(p.shopify_product_id, p.id);
    }
  }

  // Step 3: Build rows for batch upsert
  let errors = 0;
  const rows: Record<string, unknown>[] = [];
  for (const review of batch) {
    try {
      const attrs = review.attributes;
      const statusValue = attrs.status?.value || "published";
      const isFeatured = statusValue === "featured";

      const shopifyProductId = extractShopifyProductId(review) || attrs.product?.external_id || "unknown";
      const internalProductId = productIdMap.get(shopifyProductId) || null;

      const row: Record<string, unknown> = {
        workspace_id: workspaceId,
        klaviyo_review_id: review.id,
        // shopify_product_id stays as sync-side metadata; product_id is
        // the internal UUID used by every read path.
        shopify_product_id: shopifyProductId,
        product_id: internalProductId,
        reviewer_name: attrs.author || null,
        rating: attrs.rating,
        title: attrs.title || null,
        body: attrs.content || null,
        verified_purchase: attrs.verified,
        featured: isFeatured,
        published_at: attrs.created,
        updated_at: attrs.updated,
        review_type: attrs.review_type,
        status: isFeatured ? "featured" : statusValue,
        email: attrs.email || null,
        smart_quote: attrs.smart_quote || null,
        images: attrs.images || [],
        product_name: attrs.product?.name || null,
        // Don't pre-fill summary from smart_quote — let AI generate all summaries
        // smart_quote is preserved in its own column for reference
      };

      if (attrs.email) {
        const custId = customerMap.get(attrs.email.toLowerCase());
        if (custId) row.customer_id = custId;
      }

      rows.push(row);
    } catch (err) {
      console.error(`Error building row for review ${review.id}:`, err);
      errors++;
    }
  }

  // Step 4: Batch upsert
  let synced = 0;
  if (rows.length > 0) {
    const { error, count } = await admin
      .from("product_reviews")
      .upsert(rows, { onConflict: "workspace_id,klaviyo_review_id", count: "exact" });

    if (error) {
      console.error(`Batch upsert error:`, error.message);
      errors += rows.length;
    } else {
      synced = count || rows.length;
    }
  }

  return { synced, errors, nextUrl: data.links?.next || null };
}

/** Convenience wrapper: syncs all pages in one call (for non-Inngest contexts) */
export async function syncReviewsForWorkspace(
  workspaceId: string,
  options?: { fullSync?: boolean },
): Promise<{ synced: number; errors: number }> {
  let url: string | null = buildSyncUrl(options);
  let totalSynced = 0;
  let totalErrors = 0;

  while (url) {
    const result = await syncReviewPage(workspaceId, url);
    totalSynced += result.synced;
    totalErrors += result.errors;
    url = result.nextUrl;
  }

  await generateMissingSummaries(workspaceId);

  const admin = createAdminClient();
  await admin
    .from("workspaces")
    .update({ klaviyo_last_sync_at: new Date().toISOString() })
    .eq("id", workspaceId);

  return { synced: totalSynced, errors: totalErrors };
}

// ── Management: approve/reject/feature via Klaviyo API ──

export type RejectionReason = "profanity_or_inappropriate" | "private_information" | "unrelated" | "false_or_misleading" | "fake" | "other";

export async function updateReviewStatus(
  workspaceId: string,
  klaviyoReviewId: string,
  action: "publish" | "reject" | "feature" | "unfeature",
  rejectionReason?: RejectionReason,
  rejectionExplanation?: string,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getKlaviyoCredentials(workspaceId);
  if (!creds) return { success: false, error: "Klaviyo not configured" };

  const admin = createAdminClient();

  // Build PATCH body based on action
  // Klaviyo status is an object: { value: "published" }, not a plain string
  const attributes: Record<string, unknown> = {};
  let localStatus: string;

  switch (action) {
    case "publish":
      attributes.status = { value: "published" };
      localStatus = "published";
      break;
    case "reject": {
      const rejection_reason: Record<string, unknown> = { reason: rejectionReason || "other" };
      if ((rejectionReason === "other" || !rejectionReason) && rejectionExplanation) {
        rejection_reason.status_explanation = rejectionExplanation;
      }
      attributes.status = { value: "rejected", rejection_reason };
      localStatus = "rejected";
      break;
    }
    case "feature":
      attributes.status = { value: "featured" };
      localStatus = "featured";
      break;
    case "unfeature":
      attributes.status = { value: "published" };
      localStatus = "published";
      break;
  }

  try {
    const res = await fetch(`${KLAVIYO_BASE}/reviews/${klaviyoReviewId}/`, {
      method: "PATCH",
      headers: klaviyoHeaders(creds.apiKey),
      body: JSON.stringify({
        data: {
          type: "review",
          id: klaviyoReviewId,
          attributes,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Klaviyo review update failed: ${res.status}`, text);
      return { success: false, error: `Klaviyo API error: ${res.status} — ${text.slice(0, 200)}` };
    }

    // Update local DB
    const updates: Record<string, unknown> = { status: localStatus };
    if (action === "feature") updates.featured = true;
    if (action === "unfeature") updates.featured = false;

    await admin
      .from("product_reviews")
      .update(updates)
      .eq("workspace_id", workspaceId)
      .eq("klaviyo_review_id", klaviyoReviewId);

    return { success: true };
  } catch (err) {
    console.error("Klaviyo review update error:", err);
    return { success: false, error: String(err) };
  }
}

// ── Management: change review type via Klaviyo API ──

export async function updateReviewType(
  workspaceId: string,
  klaviyoReviewId: string,
  reviewType: "review" | "store",
): Promise<{ success: boolean; error?: string }> {
  const creds = await getKlaviyoCredentials(workspaceId);
  if (!creds) return { success: false, error: "Klaviyo not configured" };

  const admin = createAdminClient();

  try {
    const res = await fetch(`${KLAVIYO_BASE}/reviews/${klaviyoReviewId}/`, {
      method: "PATCH",
      headers: klaviyoHeaders(creds.apiKey),
      body: JSON.stringify({
        data: {
          type: "review",
          id: klaviyoReviewId,
          attributes: { review_type: reviewType },
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Klaviyo review type update failed: ${res.status}`, text);
      return { success: false, error: `Klaviyo API error: ${res.status}` };
    }

    await admin
      .from("product_reviews")
      .update({ review_type: reviewType })
      .eq("workspace_id", workspaceId)
      .eq("klaviyo_review_id", klaviyoReviewId);

    return { success: true };
  } catch (err) {
    console.error("Klaviyo review type update error:", err);
    return { success: false, error: String(err) };
  }
}

// ── AI summary generation for reviews without smart_quote ──

export async function generateMissingSummaries(workspaceId: string) {
  const admin = createAdminClient();

  const { data: reviews } = await admin
    .from("product_reviews")
    .select("id, body, reviewer_name, rating, title")
    .eq("workspace_id", workspaceId)
    .is("summary", null)
    .gte("rating", 4)
    .in("review_type", ["review", "store"])
    .not("body", "is", null)
    .order("featured", { ascending: false })
    .order("rating", { ascending: false })
    .limit(100);

  if (!reviews?.length) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  for (const review of reviews) {
    try {
      const firstName = review.reviewer_name?.split(" ")[0] || "Customer";
      const lastInitial = review.reviewer_name?.split(" ")[1]?.[0] || "";
      const nameDisplay = lastInitial ? `${firstName} ${lastInitial}.` : firstName;

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 50,
          messages: [
            {
              role: "user",
              content: `Summarize this product review in max 15 words as if the reviewer wrote it themselves (first person). Focus on the most compelling result or benefit. No reviewer name.\n\nTitle: ${review.title || ""}\nReview: ${review.body || ""}`,
            },
          ],
        }),
      });

      if (!aiRes.ok) continue;
      const aiData = await aiRes.json();
      const summary = (aiData.content?.[0] as { type: string; text: string })?.text?.trim();
      if (!summary) continue;

      await admin
        .from("product_reviews")
        .update({ summary })
        .eq("id", review.id);
    } catch (err) {
      console.error(`Failed to generate summary for review ${review.id}:`, err);
    }
  }
}

// ── Retrieval for cancel journey social proof ──
//
// Reviews join on the internal `product_id` UUID. Callers may still
// pass Shopify product IDs (legacy) or internal UUIDs — we resolve both.
export async function getReviewsForProducts(
  workspaceId: string,
  productIds: string[],
): Promise<{ id: string; product_id: string | null; reviewer_name: string; rating: number; title: string; body: string; summary: string; featured: boolean }[]> {
  const admin = createAdminClient();

  // Resolve mixed Shopify/internal IDs to internal product UUIDs.
  let internalIds: string[] = [];
  if (productIds.length) {
    const { data: products } = await admin
      .from("products")
      .select("id, shopify_product_id")
      .eq("workspace_id", workspaceId)
      .or(productIds.map(id => `id.eq.${id},shopify_product_id.eq.${id}`).join(","));
    internalIds = [...new Set((products || []).map(p => p.id).filter(Boolean) as string[])];
    if (!internalIds.length) return [];
  }

  const query = admin
    .from("product_reviews")
    .select("id, product_id, reviewer_name, rating, title, body, summary, featured")
    .eq("workspace_id", workspaceId)
    .in("status", ["published", "featured"])
    .gte("rating", 4)
    .order("featured", { ascending: false })
    .order("rating", { ascending: false })
    .limit(20);

  if (internalIds.length > 0) {
    query.in("product_id", internalIds);
  }

  const { data: reviews } = await query;
  return reviews || [];
}
