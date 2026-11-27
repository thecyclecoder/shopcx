/**
 * Featured-review card generator (spec: automated-social-scheduler · organic-nugget-engine Phase 1).
 *
 * Turns ShopCX **featured** reviews (`product_reviews.featured`) into designed testimonial graphics
 * and drops them into the **organic library** (`organic_content`, format='review') via the organic
 * SDK — NO longer into the ads system. Review highlights are organic content, not ad creative, so
 * they live beside the nugget carousels and animated reels, away from the paid-ad tables. (Existing
 * `ad_videos` review cards from before this move are left alone.)
 *
 * Reuses the ad-tool's `StaticReview` Remotion template (text-exact, on-brand) via
 * `renderStillCompositionTo`, at 4:5 (feed / carousel, 1080×1350 — the canonical organic ratio; the
 * 9:16 story variant is derived at post time via story-ratio.ts). Idempotent: skips any review that
 * already has an organic card (`existingOrganicReviewIds`), so a daily run does a few and **stops
 * once every featured review has a card**.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { renderStillCompositionTo } from "@/lib/ad-render";
import { uploadBuffer, AD_BUCKET } from "@/lib/ad-storage";
import { DEFAULT_BRAND, type ReviewProps } from "@/lib/ad-static";
import { uuidLineItemProductIds } from "@/lib/email-storefront";
import { insertOrganicContentDraft, existingOrganicReviewIds } from "@/lib/social/organic-content";

const COMPOSITION = "StaticReview";
// Organic feed / carousel ratio. The 9:16 story cut is derived at post time (Phase 4 story-ratio.ts).
const DIM = { w: 1080, h: 1350 };

function trimQuote(s: string, max = 180): string {
  let t = (s || "").replace(/\s+/g, " ").trim();
  // smart_quote highlights are sometimes cut mid-sentence ("t realized…").
  // Drop a leading orphan single letter (keep real words "a"/"I"), then
  // capitalize the first character so the card reads cleanly.
  t = t.replace(/^([a-z])\s+/i, (m, c) => (/[aiAI]/.test(c) ? m : ""));
  if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > max ? t.slice(0, max - 1).replace(/[,;:\s]+\S*$/, "") + "…" : t;
}

interface ReviewRow {
  id: string;
  product_id: string;
  reviewer_name: string | null;
  rating: number | null;
  smart_quote: string | null;
  body: string | null;
  verified_purchase: boolean | null;
}

/** Resolve the product's isolated pouch, else the main variant image. */
async function productImage(admin: ReturnType<typeof createAdminClient>, productId: string): Promise<string | null> {
  const { data: v } = await admin
    .from("product_variants")
    .select("isolated_image_url, image_url")
    .eq("product_id", productId)
    .order("position")
    .limit(1)
    .maybeSingle();
  return (v?.isolated_image_url as string | null) || (v?.image_url as string | null) || null;
}

function reviewProps(r: ReviewRow, productTitle: string, productImageUrl: string | null, fontKey: string): ReviewProps {
  const headline = trimQuote(r.smart_quote || r.body || "", 140);
  return {
    brand: DEFAULT_BRAND,
    reviewerName: r.reviewer_name?.trim() || "Verified Customer",
    rating: Math.min(5, Math.max(1, Math.round(r.rating ?? 5))),
    headline,
    body: r.body || null, // shown below the headline (template truncates to fit)
    quote: headline,
    verified: !!r.verified_purchase,
    productTitle,
    productImageUrl,
    fontKey,
  };
}

/** Render + store one review's 4:5 card and insert it into the organic library (status='approved'). */
async function makeCard(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  review: ReviewRow,
  productTitle: string,
  fontKey: string,
): Promise<{ reviewId: string; contentId: string }> {
  const imageUrl = await productImage(admin, review.product_id);
  const props = reviewProps(review, productTitle, imageUrl, fontKey) as unknown as Record<string, unknown>;

  const tmp = `/tmp/revcard_${review.id}.jpg`;
  await renderStillCompositionTo(COMPOSITION, { width: DIM.w, height: DIM.h, ...props }, tmp);
  const fs = await import("fs/promises");
  const buf = await fs.readFile(tmp);
  // Private bucket asset (re-signed at publish — never persist a signed URL).
  const storagePath = `organic/reviews/${workspaceId}/${review.id}.jpg`;
  await uploadBuffer(storagePath, buf, "image/jpeg");

  const headline = trimQuote(review.smart_quote || review.body || "", 140);
  // Already human-featured, so insert approved (preserves the prior auto-posting behaviour).
  const content = await insertOrganicContentDraft(admin, workspaceId, {
    format: "review",
    title: `${productTitle} — ${review.reviewer_name?.trim() || "Verified Customer"}`,
    hook: headline,
    slides: [{ headline, body: review.body || null, image_bucket: AD_BUCKET, image_path: storagePath }],
    product_id: review.product_id,
    review_id: review.id,
    created_by: "featured_review_card",
    status: "approved",
  });
  return { reviewId: review.id, contentId: content.id };
}

export interface ReviewCardResult {
  made: number;
  remaining: number;
  cards: Array<{ reviewId: string; product: string }>;
}

/**
 * Generate up to `max` featured-review cards for a workspace, spread across
 * products for variety. Skips reviews already carded; returns how many remain.
 */
export async function generateFeaturedReviewCards(
  workspaceId: string,
  max = 3,
  opts: { productId?: string } = {},
): Promise<ReviewCardResult> {
  const admin = createAdminClient();
  // Brand font from Storefront settings (default montserrat).
  const { data: ws } = await admin.from("workspaces").select("storefront_font").eq("id", workspaceId).maybeSingle();
  const fontKey = (ws?.storefront_font as string | null) || "montserrat";
  const carded = await existingOrganicReviewIds(admin, workspaceId);

  let q = admin
    .from("product_reviews")
    .select("id, product_id, reviewer_name, rating, smart_quote, body, verified_purchase")
    .eq("workspace_id", workspaceId)
    .eq("featured", true)
    .not("product_id", "is", null);
  if (opts.productId) q = q.eq("product_id", opts.productId);
  const { data: featured } = await q;

  const candidates = (featured || []).filter(
    (r) => !carded.has(r.id) && ((r.smart_quote && r.smart_quote.trim().length > 8) || (r.body && r.body.trim().length > 12)),
  ) as ReviewRow[];

  // Round-robin across products so a daily run spreads variety, not 43 of one.
  const byProduct = new Map<string, ReviewRow[]>();
  for (const r of candidates) (byProduct.get(r.product_id) ?? byProduct.set(r.product_id, []).get(r.product_id)!).push(r);
  const queues = Array.from(byProduct.values());
  const ordered: ReviewRow[] = [];
  for (let i = 0; ordered.length < candidates.length; i++) {
    const queue = queues[i % queues.length];
    const next = queue.shift();
    if (next) ordered.push(next);
    if (queues.every((qq) => qq.length === 0)) break;
  }

  // Resolve product titles once.
  // Shopify-numeric line-item id would 22P02 the whole query — see uuidLineItemProductIds in email-storefront.ts
  const productIds = uuidLineItemProductIds(Array.from(new Set(ordered.map((r) => r.product_id))));
  const { data: products } = await admin.from("products").select("id, title").in("id", productIds.length ? productIds : ["00000000-0000-0000-0000-000000000000"]);
  const titleById = new Map((products || []).map((p) => [p.id, p.title as string]));

  const cards: ReviewCardResult["cards"] = [];
  for (const review of ordered.slice(0, max)) {
    const title = titleById.get(review.product_id) || "Our Product";
    try {
      await makeCard(admin, workspaceId, review, title, fontKey);
      cards.push({ reviewId: review.id, product: title });
    } catch (e) {
      console.error(`[featured-review-cards] ${review.id} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return { made: cards.length, remaining: candidates.length - cards.length, cards };
}
