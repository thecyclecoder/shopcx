/**
 * Featured-review card generator (spec: automated-social-scheduler).
 *
 * Turns ShopCX **featured** reviews (`product_reviews.featured`) into designed
 * testimonial graphics and drops them into the **ad library** (`ad_videos`
 * statics) under a per-product "{Product} Reviews" campaign — so the social
 * poster's `pickTestimonial` finds them with no changes, and the ad tool can
 * reuse them too.
 *
 * Reuses the ad-tool's `StaticReview` Remotion template (text-exact, on-brand)
 * via `renderStillCompositionTo`, at 9:16 (story) + 4:5 (feed). Idempotent:
 * tracks which reviews are carded via `meta.review_id`, so a daily run does a
 * few and **stops once every featured review has a card**.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { renderStillCompositionTo } from "@/lib/ad-render";
import { uploadBuffer, signedUrl } from "@/lib/ad-storage";
import { DEFAULT_BRAND, type ReviewProps } from "@/lib/ad-static";

const COMPOSITION = "StaticReview";
const SOURCE = "featured_review_card";
const DIMS: Array<{ format: string; w: number; h: number }> = [
  { format: "stories_9x16", w: 1080, h: 1920 }, // canonical
  { format: "feed_4x5", w: 1080, h: 1350 },
];

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

/** ad_videos meta payloads, narrowed. */
type StaticMeta = { source?: string; review_id?: string } | null;

/** review_ids that already have a generated card in this workspace. */
async function cardedReviewIds(admin: ReturnType<typeof createAdminClient>, workspaceId: string): Promise<Set<string>> {
  const { data } = await admin
    .from("ad_videos")
    .select("meta")
    .eq("workspace_id", workspaceId)
    .eq("media_kind", "static");
  const set = new Set<string>();
  for (const r of data || []) {
    const m = r.meta as StaticMeta;
    if (m?.source === SOURCE && m.review_id) set.add(m.review_id);
  }
  return set;
}

/** Find (or create) the "{Product} Reviews" campaign the cards live under. */
async function reviewsCampaignId(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  productId: string,
  productTitle: string,
): Promise<string> {
  const name = `${productTitle} Reviews`;
  const { data: existing } = await admin
    .from("ad_campaigns")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("name", name)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data: created, error } = await admin
    .from("ad_campaigns")
    .insert({ workspace_id: workspaceId, product_id: productId, name, status: "ready" })
    .select("id")
    .single();
  if (error || !created) throw new Error(`create reviews campaign failed: ${error?.message}`);
  return created.id;
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

function reviewProps(r: ReviewRow, productTitle: string, productImageUrl: string | null): ReviewProps {
  return {
    brand: DEFAULT_BRAND,
    reviewerName: r.reviewer_name?.trim() || "Verified Customer",
    rating: Math.min(5, Math.max(1, Math.round(r.rating ?? 5))),
    quote: trimQuote(r.smart_quote || r.body || ""),
    verified: !!r.verified_purchase,
    productTitle,
    productImageUrl,
  };
}

/** Render + store one review's card (9:16 canonical + 4:5 sibling) in the ad library. */
async function makeCard(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  review: ReviewRow,
  productTitle: string,
): Promise<{ reviewId: string; canonicalId: string }> {
  const campaignId = await reviewsCampaignId(admin, workspaceId, review.product_id, productTitle);
  const imageUrl = await productImage(admin, review.product_id);
  const props = reviewProps(review, productTitle, imageUrl) as unknown as Record<string, unknown>;

  let canonicalId: string | null = null;
  for (const dim of DIMS) {
    const ins = await admin
      .from("ad_videos")
      .insert({
        workspace_id: workspaceId, campaign_id: campaignId, format: dim.format,
        media_kind: "static", format_variant_of_id: canonicalId, status: "rendering",
        meta: { archetype: "review", source: SOURCE, review_id: review.id },
      })
      .select("id").single();
    const row = ins.data as { id: string } | null;
    if (ins.error || !row) throw new Error(`ad_videos insert failed: ${ins.error?.message}`);
    if (!canonicalId) canonicalId = row.id;
    const tmp = `/tmp/revcard_${row.id}.jpg`;
    await renderStillCompositionTo(COMPOSITION, { width: dim.w, height: dim.h, ...props }, tmp);
    const fs = await import("fs/promises");
    const buf = await fs.readFile(tmp);
    const storagePath = `finals/${workspaceId}/${row.id}.jpg`;
    await uploadBuffer(storagePath, buf, "image/jpeg");
    const url = await signedUrl(storagePath);
    await admin.from("ad_videos").update({
      static_jpg_url: url, status: "ready",
      meta: { archetype: "review", source: SOURCE, review_id: review.id, storage_path: storagePath },
    }).eq("id", row.id);
  }
  return { reviewId: review.id, canonicalId: canonicalId! };
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
  const carded = await cardedReviewIds(admin, workspaceId);

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
  const productIds = Array.from(new Set(ordered.map((r) => r.product_id)));
  const { data: products } = await admin.from("products").select("id, title").in("id", productIds.length ? productIds : ["00000000-0000-0000-0000-000000000000"]);
  const titleById = new Map((products || []).map((p) => [p.id, p.title as string]));

  const cards: ReviewCardResult["cards"] = [];
  for (const review of ordered.slice(0, max)) {
    const title = titleById.get(review.product_id) || "Our Product";
    try {
      await makeCard(admin, workspaceId, review, title);
      cards.push({ reviewId: review.id, product: title });
    } catch (e) {
      console.error(`[featured-review-cards] ${review.id} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return { made: cards.length, remaining: candidates.length - cards.length, cards };
}
