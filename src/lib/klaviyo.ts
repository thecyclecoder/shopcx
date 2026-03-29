/**
 * Klaviyo API client — reviews sync, management, and retrieval.
 *
 * Klaviyo Reviews API fields (from actual API docs):
 * - review_type: "review" | "question" | "rating" | "store"
 * - status.value: "published" | "pending" | "featured" | "rejected"
 * - product.external_id: Shopify product ID
 * - smart_quote: AI-extracted excerpt
 * - email: reviewer email (server API only)
 * - images: array of image URLs
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

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

// ── Sync reviews to our DB ──

export async function syncReviewsForWorkspace(
  workspaceId: string,
  options?: { fullSync?: boolean },
): Promise<{ synced: number; errors: number }> {
  const creds = await getKlaviyoCredentials(workspaceId);
  if (!creds) return { synced: 0, errors: 0 };

  const admin = createAdminClient();

  // Nightly cron: last 30 days. Manual/first sync: everything.
  const sinceDate = options?.fullSync
    ? undefined
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const reviews = await fetchKlaviyoReviews(workspaceId, { sinceDate });

  let synced = 0;
  let errors = 0;

  for (const review of reviews) {
    try {
      const attrs = review.attributes;
      const statusValue = attrs.status?.value || "published";
      const isFeatured = statusValue === "featured";
      const shopifyProductId = attrs.product?.external_id || null;

      const row: Record<string, unknown> = {
        workspace_id: workspaceId,
        klaviyo_review_id: review.id,
        shopify_product_id: shopifyProductId || "unknown",
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
        // summary: use smart_quote from Klaviyo if available, otherwise keep existing
        ...(attrs.smart_quote ? { summary: attrs.smart_quote } : {}),
      };

      // Resolve customer_id from email
      if (attrs.email) {
        const { data: cust } = await admin
          .from("customers")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("email", attrs.email)
          .limit(1)
          .single();
        if (cust) row.customer_id = cust.id;
      }

      const { error } = await admin
        .from("product_reviews")
        .upsert(row, { onConflict: "workspace_id,klaviyo_review_id" });

      if (error) {
        console.error(`Review upsert error for ${review.id}:`, error.message);
        errors++;
      } else {
        synced++;
      }
    } catch (err) {
      console.error(`Error processing review ${review.id}:`, err);
      errors++;
    }
  }

  // Generate AI summaries for reviews without smart_quote or summary
  await generateMissingSummaries(workspaceId);

  // Update last sync timestamp
  await admin
    .from("workspaces")
    .update({ klaviyo_last_sync_at: new Date().toISOString() })
    .eq("id", workspaceId);

  return { synced, errors };
}

// ── Management: approve/reject/feature via Klaviyo API ──

export async function updateReviewStatus(
  workspaceId: string,
  klaviyoReviewId: string,
  action: "publish" | "reject" | "feature" | "unfeature",
): Promise<{ success: boolean; error?: string }> {
  const creds = await getKlaviyoCredentials(workspaceId);
  if (!creds) return { success: false, error: "Klaviyo not configured" };

  const admin = createAdminClient();

  // Build PATCH body based on action
  const attributes: Record<string, unknown> = {};
  let localStatus: string;

  switch (action) {
    case "publish":
      attributes.status = "published";
      localStatus = "published";
      break;
    case "reject":
      attributes.status = "rejected";
      localStatus = "rejected";
      break;
    case "feature":
      attributes.featured = true;
      localStatus = "featured";
      break;
    case "unfeature":
      attributes.featured = false;
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
      return { success: false, error: `Klaviyo API error: ${res.status}` };
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

async function generateMissingSummaries(workspaceId: string) {
  const admin = createAdminClient();

  const { data: reviews } = await admin
    .from("product_reviews")
    .select("id, body, reviewer_name, rating, title")
    .eq("workspace_id", workspaceId)
    .is("summary", null)
    .gt("rating", 3)
    .in("review_type", ["review", "store"])
    .limit(50);

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
          model: "claude-haiku-4-5-20251001",
          max_tokens: 50,
          messages: [
            {
              role: "user",
              content: `Summarize this product review in max 15 words. Start with "${nameDisplay}". Focus on the most compelling result or benefit.\n\nTitle: ${review.title || ""}\nReview: ${review.body || ""}`,
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

export async function getReviewsForProducts(
  workspaceId: string,
  shopifyProductIds: string[],
): Promise<{ id: string; shopify_product_id: string; reviewer_name: string; rating: number; title: string; body: string; summary: string; featured: boolean }[]> {
  const admin = createAdminClient();

  const query = admin
    .from("product_reviews")
    .select("id, shopify_product_id, reviewer_name, rating, title, body, summary, featured")
    .eq("workspace_id", workspaceId)
    .in("status", ["published", "featured"])
    .gte("rating", 4)
    .order("featured", { ascending: false })
    .order("rating", { ascending: false })
    .limit(20);

  if (shopifyProductIds.length > 0) {
    query.in("shopify_product_id", shopifyProductIds);
  }

  const { data: reviews } = await query;
  return reviews || [];
}
