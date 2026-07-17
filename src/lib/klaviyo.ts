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
import { resolveProductsByMixedIds } from "@/lib/resolve-products-by-mixed-ids";
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

export async function getKlaviyoCredentials(workspaceId: string): Promise<{ apiKey: string; publicKey: string | null } | null> {
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
  //
  // Reviews flagged with body_locked_at have been hand-edited by an admin
  // (typo fix, profanity scrub, etc). The sync must update everything ELSE
  // on the row — rating, status, smart_quote, engagement, product link —
  // but leave the body alone so the manual fix isn't steamrolled.
  let synced = 0;
  if (rows.length > 0) {
    const reviewIds = rows.map(r => r.klaviyo_review_id as string);
    const { data: lockedRows } = await admin
      .from("product_reviews")
      .select("klaviyo_review_id")
      .eq("workspace_id", workspaceId)
      .in("klaviyo_review_id", reviewIds)
      .not("body_locked_at", "is", null);
    const lockedIds = new Set((lockedRows || []).map(r => r.klaviyo_review_id as string));

    const finalRows = rows.map(r => {
      if (lockedIds.has(r.klaviyo_review_id as string)) {
        const { body: _body, ...rest } = r;
        return rest;
      }
      return r;
    });

    const { error, count } = await admin
      .from("product_reviews")
      .upsert(finalRows, { onConflict: "workspace_id,klaviyo_review_id", count: "exact" });

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

  // Polish before summarize: the summary should be generated against
  // clean text, not a "manger to lose" body that Haiku will faithfully
  // reproduce in the 15-word summary.
  await polishReviewBodies(workspaceId);
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

// ── Haiku polish pass for new review bodies ──
//
// Customers leave reviews on phones with autocorrect — "manger" instead of
// "managed", "their" vs "there", missing commas, etc. We don't paraphrase
// or rewrite; we just fix obvious typos and grammar mistakes so the
// review reads cleanly when shown on the storefront. Voice and content
// stay intact.
//
// Eligibility per row:
//   body_polished_at IS NULL  — never polished
//   body_locked_at   IS NULL  — admin hasn't hand-edited
//   body             IS NOT NULL
//   rating          >= 4      — we only display 4+ on the site
//   review_type     IN review/store
//
// After polish, body_polished_at = now() so the row is skipped next time.
export async function polishReviewBodies(workspaceId: string) {
  const admin = createAdminClient();

  const { data: reviews } = await admin
    .from("product_reviews")
    .select("id, body, smart_quote, title")
    .eq("workspace_id", workspaceId)
    .is("body_polished_at", null)
    .is("body_locked_at", null)
    .gte("rating", 4)
    .in("review_type", ["review", "store"])
    .not("body", "is", null)
    .order("featured", { ascending: false })
    .order("published_at", { ascending: false })
    .limit(200);

  if (!reviews?.length) return;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  for (const review of reviews) {
    try {
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content: `You are proofreading a customer product review for display on a storefront. Fix ONLY obvious typos, autocorrect mistakes, and missing punctuation.

DO:
- Fix clear typos ("manger" → "managed", "thier" → "their", "wieght" → "weight")
- Add missing periods, fix run-on sentences with appropriate punctuation
- Capitalize the start of sentences
- Fix obvious grammar errors that would embarrass the customer

DO NOT:
- Paraphrase, rewrite, or "improve" wording
- Add or remove content, ideas, or sentences
- Change voice, tone, or style
- Translate informal phrases into formal ones
- Add hedging or marketing language

Return ONLY valid JSON in this exact shape, no markdown, no explanation:
{"body": "<corrected body>", "smart_quote": "<corrected quote, or null if input was null>", "changed": <true|false>}

If the text is already clean, set changed=false and return body/smart_quote unchanged.

Title: ${review.title || ""}
Body: ${review.body || ""}
Smart quote: ${review.smart_quote || "null"}`,
            },
          ],
        }),
      });

      if (!aiRes.ok) {
        console.warn(`[polishReviewBodies] HTTP ${aiRes.status} for review ${review.id}`);
        // Stamp polished_at anyway so we don't infinite-retry a broken row.
        await admin.from("product_reviews").update({ body_polished_at: new Date().toISOString() }).eq("id", review.id);
        continue;
      }
      const aiData = await aiRes.json();
      const raw = (aiData.content?.[0] as { type: string; text: string })?.text?.trim() || "";
      let parsed: { body?: string; smart_quote?: string | null; changed?: boolean };
      try {
        // Haiku occasionally wraps in ```json fences — strip them.
        const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        console.warn(`[polishReviewBodies] could not parse Haiku output for review ${review.id}; stamping as polished anyway`);
        await admin.from("product_reviews").update({ body_polished_at: new Date().toISOString() }).eq("id", review.id);
        continue;
      }

      const nowIso = new Date().toISOString();
      const update: Record<string, unknown> = { body_polished_at: nowIso, updated_at: nowIso };
      if (parsed.changed === true) {
        if (typeof parsed.body === "string" && parsed.body.trim()) update.body = parsed.body;
        if (typeof parsed.smart_quote === "string" && parsed.smart_quote.trim()) update.smart_quote = parsed.smart_quote;
      }
      await admin.from("product_reviews").update(update).eq("id", review.id);
    } catch (err) {
      console.error(`[polishReviewBodies] failed for review ${review.id}:`, err);
    }
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

  // Resolve mixed Shopify/internal IDs to internal product UUIDs. fix-1-mixed-id-resolver —
  // Fix 1 of docs/brain/specs/spec-read-efficiency-for-scaling-fleet.md retires the mixed-ID
  // `.or()` filter string (security agent flagged as injection · medium in the sibling reviews.ts
  // callsite) in favor of two parameter-safe `.in()` queries composed inside the shared helper.
  let internalIds: string[] = [];
  if (productIds.length) {
    const products = await resolveProductsByMixedIds(admin, workspaceId, productIds);
    internalIds = [...new Set(products.map((p) => p.id).filter(Boolean))];
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
