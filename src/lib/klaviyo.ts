/**
 * Klaviyo API client — reviews sync for cancel journey social proof.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const KLAVIYO_REVISION = "2024-10-15";

interface KlaviyoReview {
  id: string;
  attributes: {
    rating: number;
    title: string;
    body: string;
    author: string;
    product_external_id: string;
    is_verified_buyer: boolean;
    smart_featured: boolean;
    created: string;
  };
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

export async function fetchKlaviyoReviews(
  workspaceId: string,
  shopifyProductId: string,
): Promise<KlaviyoReview[]> {
  const creds = await getKlaviyoCredentials(workspaceId);
  if (!creds) return [];

  const allReviews: KlaviyoReview[] = [];
  let url: string | null = `${KLAVIYO_BASE}/reviews/?filter=equals(product_external_id,"${shopifyProductId}")&sort=-rating`;

  while (url) {
    const fetchRes: Response = await fetch(url, {
      headers: {
        Authorization: `Klaviyo-API-Key ${creds.apiKey}`,
        revision: KLAVIYO_REVISION,
        Accept: "application/json",
      },
    });

    if (!fetchRes.ok) {
      console.error(`Klaviyo reviews fetch failed for product ${shopifyProductId}: ${fetchRes.status}`);
      break;
    }

    const fetchData: { data?: KlaviyoReview[]; links?: { next?: string } } = await fetchRes.json();
    allReviews.push(...(fetchData.data || []));
    url = fetchData.links?.next || null;
  }

  return allReviews;
}

export async function syncReviewsForWorkspace(workspaceId: string): Promise<{ synced: number; errors: number }> {
  const creds = await getKlaviyoCredentials(workspaceId);
  if (!creds) return { synced: 0, errors: 0 };

  const admin = createAdminClient();

  // Get all products for this workspace
  const { data: products } = await admin
    .from("products")
    .select("shopify_product_id")
    .eq("workspace_id", workspaceId);

  if (!products?.length) return { synced: 0, errors: 0 };

  let synced = 0;
  let errors = 0;

  for (const product of products) {
    try {
      const reviews = await fetchKlaviyoReviews(workspaceId, product.shopify_product_id);

      for (const review of reviews) {
        const { error } = await admin
          .from("product_reviews")
          .upsert(
            {
              workspace_id: workspaceId,
              shopify_product_id: review.attributes.product_external_id,
              reviewer_name: review.attributes.author,
              rating: review.attributes.rating,
              title: review.attributes.title,
              body: review.attributes.body,
              verified_purchase: review.attributes.is_verified_buyer,
              featured: review.attributes.smart_featured,
              klaviyo_review_id: review.id,
              published_at: review.attributes.created,
            },
            { onConflict: "workspace_id,klaviyo_review_id" },
          );

        if (error) {
          errors++;
        } else {
          synced++;
        }
      }
    } catch (err) {
      console.error(`Error syncing reviews for product ${product.shopify_product_id}:`, err);
      errors++;
    }
  }

  // Generate AI summaries for reviews that don't have one
  await generateMissingSummaries(workspaceId);

  // Update last sync timestamp
  await admin
    .from("workspaces")
    .update({ klaviyo_last_sync_at: new Date().toISOString() })
    .eq("id", workspaceId);

  return { synced, errors };
}

async function generateMissingSummaries(workspaceId: string) {
  const admin = createAdminClient();

  const { data: reviews } = await admin
    .from("product_reviews")
    .select("id, body, reviewer_name, rating, title")
    .eq("workspace_id", workspaceId)
    .is("summary", null)
    .gt("rating", 3)
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

export async function getReviewsForProducts(
  workspaceId: string,
  shopifyProductIds: string[],
): Promise<{ id: string; shopify_product_id: string; reviewer_name: string; rating: number; title: string; body: string; summary: string; featured: boolean }[]> {
  if (!shopifyProductIds.length) return [];

  const admin = createAdminClient();
  const { data: reviews } = await admin
    .from("product_reviews")
    .select("id, shopify_product_id, reviewer_name, rating, title, body, summary, featured")
    .eq("workspace_id", workspaceId)
    .in("shopify_product_id", shopifyProductIds)
    .gte("rating", 4)
    .order("featured", { ascending: false })
    .order("rating", { ascending: false })
    .limit(20);

  return reviews || [];
}
