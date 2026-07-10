/**
 * product-intelligence — the single READ front door for EVERY shred of product intelligence on a
 * product, denormalized for ad-creative generation (so every claim an ad makes is verifiable by
 * construction — no fabrication, no human gate). Replaces the deprecated `product_intelligence` blob
 * table (the ShopGrowth-era monolith, dropped) — this reads the rich structured surface built since:
 *
 *   claim spine → product_benefit_selections (lead/support benefits w/ customer_phrases + linked
 *     review_ids + ingredient_research_ids) · product_ingredient_research (mechanism + clinical
 *     citations + contraindications) · product_ingredients (dosages)
 *   hooks       → product_ad_angles (LF8 hooks + ready Meta copy)
 *   copy        → product_page_content (hero, benefit bar, mechanism, comparison, expectation
 *     timeline, endorsements, before/after, guarantee, kb_what_it_doesnt_do = claim guardrails)
 *   proof       → product_review_analysis (claim clusters w/ frequency + review_ids + phrases +
 *     skeptic conversions) + product_reviews (featured / recent-5★ / with-photo / by-claim)
 *   imagery     → product_media (by persuasive category) + product_variants (isolated packshots)
 *   content     → posts via post_products (science / how-it-works / recipes blogs)
 *   demand      → product_seo_keywords · daily_amazon_product_snapshots
 *
 * Keyed on `products.id` (UUID). READ-ONLY. See [[../../docs/brain/libraries/product-intelligence]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;
type Row = Record<string, unknown>;

// ── Review sub-shape ─────────────────────────────────────────────────────────
export interface PIReview {
  id: string;
  reviewer_name: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  summary: string | null;
  smart_quote: string | null;
  verified_purchase: boolean | null;
  featured: boolean | null;
  images: string[];
  cancel_relevance: unknown;
  published_at: string | null;
}

export interface ProductOffer {
  subscribeDiscountPct: number;
  freeShipping: boolean;
  quantityBreaks: Array<{ label: string; quantity: number; discount_pct: number }>;
  /** The best case: SnS × volume compounded (multiplicative). e.g. 25% SnS × 12% (3+) = 34% off. */
  maxCompoundDiscountPct: number;
  /** Ad-ready headline, e.g. "Up to 34% off + free shipping (25% Subscribe & Save + up to 12% for 3+ units)". */
  headline: string;
  // ── Price-on-static inputs (staticPriceRule) ──────────────────────────────────
  // A bare MSRP on a static is a HARD NO. The ONLY allowed treatments are:
  //   (a) MSRP strikethrough → discounted price, with the disclaimer; or
  //   (b) per-serving cost at the discount vs a $4–8 coffee/latte.
  // The SDK supplies the numbers; the display rule lives in meta-scaling-methodology.
  msrpCents: number | null;              // single-unit MSRP (the number you may NEVER show bare)
  discountedUnitCents: number | null;    // MSRP × (1 − maxCompound%) — the price you show AFTER the strikethrough
  servingsPerUnit: number | null;
  perServingCents: number | null;        // discountedUnitCents / servings — e.g. ~$1.50/cup vs a $4–8 latte
  disclaimer: string;                    // e.g. "with 3+ units on Subscribe & Save"
}

export interface ProductIntelligence {
  product: Row | null;
  benefits: Row[];
  ingredients: Row[];
  ingredientResearch: Row[];
  adAngles: Row[];
  pageContent: Row | null;
  reviewAnalysis: Row | null;
  reviews: {
    totalCount: number;
    fiveStarCount: number;
    featured: PIReview[];
    recentFiveStar: PIReview[];
    withPhotos: PIReview[];
    /** Resolve verbatim reviews backing a benefit cluster (via review_analysis.top_benefits[].review_ids). */
    byClaim: (benefitName: string) => Promise<PIReview[]>;
  };
  media: {
    all: Row[];
    byCategory: Record<string, Row[]>;
    /** Historic rows have NULL category — fall back to slot-prefix (e.g. "before", "ingredient_"). */
    bySlotPrefix: (prefix: string) => Row[];
    isolatedPackshots: string[]; // from product_variants.isolated_image_url
  };
  blogPosts: Row[];
  seoKeywords: Row[];
  /** Store/brand-wide selling points (workspace-level, same for every product): guarantee, 700k customers,
   *  family-owned, Austin TX, etc. — the "overall selling points" blind spot the product tables don't hold. */
  store: { brandProofPoints: string[] };
  /** The computed headline offer from the product's active pricing rule (SnS + volume, compounded). */
  offer: ProductOffer | null;
  variants: Row[];
  /** Sources that were empty for this product — surfaced, never silently swallowed. */
  gaps: string[];
}

const MEDIA_CATEGORIES = ["hero", "ingredient", "before_after", "lifestyle", "testimonial_photo", "ugc", "press_logo", "mechanism", "other"] as const;

function toReview(r: Row): PIReview {
  return {
    id: String(r.id),
    reviewer_name: (r.reviewer_name as string | null) ?? null,
    rating: Number(r.rating ?? 0),
    title: (r.title as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    smart_quote: (r.smart_quote as string | null) ?? null,
    verified_purchase: (r.verified_purchase as boolean | null) ?? null,
    featured: (r.featured as boolean | null) ?? null,
    images: Array.isArray(r.images) ? (r.images as string[]) : [],
    cancel_relevance: r.cancel_relevance ?? null,
    published_at: (r.published_at as string | null) ?? null,
  };
}

const REVIEW_COLS = "id, reviewer_name, rating, title, body, summary, smart_quote, verified_purchase, featured, images, cancel_relevance, published_at";

/**
 * Pull the complete product-intelligence object for one product (by `products.id`). Fans out to every
 * source in parallel. `reviews.byClaim` is lazy (a closure) so we don't over-fetch the 3k-review corpus
 * up front — pass the benefit_name of a `reviewAnalysis.top_benefits` cluster to get its verbatim reviews.
 */
export async function getProductIntelligence(
  admin: Admin,
  workspaceId: string,
  productId: string,
): Promise<ProductIntelligence> {
  const q = (t: string) => admin.from(t).select("*").eq("workspace_id", workspaceId).eq("product_id", productId);

  const [
    product, benefits, ingredients, ingredientResearch, adAngles, pageContentRows,
    reviewAnalysis, media, variants, postLinks, seoKeywords,
    reviewsTotal, fiveStarCount, featured, recentFiveStar, withPhotos,
  ] = await Promise.all([
    admin.from("products").select("*").eq("workspace_id", workspaceId).eq("id", productId).maybeSingle(),
    q("product_benefit_selections").order("display_order", { ascending: true }),
    q("product_ingredients").order("display_order", { ascending: true }),
    q("product_ingredient_research"),
    q("product_ad_angles").eq("is_active", true),
    q("product_page_content").eq("status", "published").order("version", { ascending: false }).limit(1),
    q("product_review_analysis").order("analyzed_at", { ascending: false }).limit(1).maybeSingle(),
    q("product_media").order("display_order", { ascending: true }),
    q("product_variants"),
    admin.from("post_products").select("post_id").eq("workspace_id", workspaceId).eq("product_id", productId),
    q("product_seo_keywords").eq("is_selected", true),
    admin.from("product_reviews").select("*", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("product_id", productId),
    admin.from("product_reviews").select("*", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("product_id", productId).eq("rating", 5),
    admin.from("product_reviews").select(REVIEW_COLS).eq("workspace_id", workspaceId).eq("product_id", productId).eq("featured", true).order("published_at", { ascending: false }).limit(25),
    admin.from("product_reviews").select(REVIEW_COLS).eq("workspace_id", workspaceId).eq("product_id", productId).eq("rating", 5).order("published_at", { ascending: false }).limit(10),
    admin.from("product_reviews").select(REVIEW_COLS).eq("workspace_id", workspaceId).eq("product_id", productId).neq("images", "{}").order("published_at", { ascending: false }).limit(15),
  ]);

  const mediaRows = (media.data ?? []) as Row[];
  const byCategory: Record<string, Row[]> = {};
  for (const cat of MEDIA_CATEGORIES) byCategory[cat] = [];
  for (const m of mediaRows) {
    const cat = (m.category as string | null) ?? "other";
    (byCategory[cat] ??= []).push(m);
  }
  const isolatedPackshots = ((variants.data ?? []) as Row[])
    .map((v) => v.isolated_image_url as string | null)
    .filter((u): u is string => !!u);

  // Blogs: resolve linked post_ids → posts.
  const postIds = ((postLinks.data ?? []) as { post_id: string }[]).map((p) => p.post_id);
  let blogPosts: Row[] = [];
  if (postIds.length) {
    const { data } = await admin
      .from("posts")
      .select("id, title, handle, blog_handle, grouping, excerpt, content_text, featured_image_url, published_at")
      .eq("workspace_id", workspaceId)
      .in("id", postIds)
      .eq("published", true);
    blogPosts = (data ?? []) as Row[];
  }

  const analysis = (reviewAnalysis.data ?? null) as Row | null;

  // byClaim: map a benefit cluster's review_ids back to the verbatim reviews.
  const byClaim = async (benefitName: string): Promise<PIReview[]> => {
    const clusters = (analysis?.top_benefits as Array<{ benefit: string; review_ids?: string[] }> | undefined) ?? [];
    const match = clusters.find((c) => c.benefit?.toLowerCase() === benefitName.toLowerCase())
      ?? clusters.find((c) => c.benefit?.toLowerCase().includes(benefitName.toLowerCase()));
    const ids = (match?.review_ids ?? []).slice(0, 20);
    if (!ids.length) return [];
    const { data } = await admin.from("product_reviews").select(REVIEW_COLS).eq("workspace_id", workspaceId).in("id", ids);
    return ((data ?? []) as Row[]).map(toReview);
  };

  const pageContent = ((pageContentRows.data ?? []) as Row[])[0] ?? null;

  // Store/brand-level selling points (workspace-wide, NOT product-specific — the blind spot: guarantee,
  // 700k customers, family-owned, based in Austin TX, etc.). Lives in workspaces.social_brand_proof_points
  // as a newline blob; split to a list. + the computed headline offer from the product's pricing rule.
  const { data: wsRow } = await admin.from("workspaces").select("social_brand_proof_points").eq("id", workspaceId).maybeSingle();
  const brandProofPoints = String((wsRow as { social_brand_proof_points?: string } | null)?.social_brand_proof_points ?? "")
    .split("\n").map((l) => l.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
  const offer = await loadOffer(admin, workspaceId, productId, (variants.data ?? []) as Row[]);

  const gaps: string[] = [];
  if (!brandProofPoints.length) gaps.push("workspaces.social_brand_proof_points (no store selling points set)");
  if (!offer) gaps.push("pricing_rules (no active offer configured)");
  if (!(benefits.data ?? []).length) gaps.push("product_benefit_selections (no curated benefits)");
  if (!(adAngles.data ?? []).length) gaps.push("product_ad_angles (no ready-made hooks — needs generation)");
  if (!pageContent) gaps.push("product_page_content (no published PDP copy)");
  if (!analysis) gaps.push("product_review_analysis (reviews not yet claim-categorized)");
  if (!mediaRows.length) gaps.push("product_media (no imagery)");

  return {
    product: (product.data ?? null) as Row | null,
    benefits: (benefits.data ?? []) as Row[],
    ingredients: (ingredients.data ?? []) as Row[],
    ingredientResearch: (ingredientResearch.data ?? []) as Row[],
    adAngles: (adAngles.data ?? []) as Row[],
    pageContent,
    reviewAnalysis: analysis,
    reviews: {
      totalCount: reviewsTotal.count ?? 0,
      fiveStarCount: fiveStarCount.count ?? 0,
      featured: ((featured.data ?? []) as Row[]).map(toReview),
      recentFiveStar: ((recentFiveStar.data ?? []) as Row[]).map(toReview),
      withPhotos: ((withPhotos.data ?? []) as Row[]).map(toReview),
      byClaim,
    },
    media: {
      all: mediaRows,
      byCategory,
      bySlotPrefix: (prefix: string) => mediaRows.filter((m) => String(m.slot ?? "").startsWith(prefix)),
      isolatedPackshots,
    },
    blogPosts,
    seoKeywords: (seoKeywords.data ?? []) as Row[],
    variants: (variants.data ?? []) as Row[],
    store: { brandProofPoints },
    offer,
    gaps,
  };
}

/** Compute the ad-ready offer for a product from its active pricing rule + variants. SnS and volume
 *  discounts compound multiplicatively (the real cart math), and the per-serving cost is at the
 *  discounted unit price — the two number sets an ad may legally show instead of a bare MSRP. */
async function loadOffer(admin: Admin, workspaceId: string, productId: string, variants: Row[]): Promise<ProductOffer | null> {
  const { data: link } = await admin.from("product_pricing_rule").select("pricing_rule_id").eq("workspace_id", workspaceId).eq("product_id", productId).maybeSingle();
  const ruleId = (link as { pricing_rule_id?: string } | null)?.pricing_rule_id;
  if (!ruleId) return null;
  const { data: rule } = await admin.from("pricing_rules").select("subscribe_discount_pct, free_shipping, quantity_breaks").eq("id", ruleId).maybeSingle();
  if (!rule) return null;
  const r = rule as { subscribe_discount_pct: number | null; free_shipping: boolean | null; quantity_breaks: Array<{ label: string; quantity: number; discount_pct: number }> | null };
  const sns = Number(r.subscribe_discount_pct ?? 0);
  const breaks = Array.isArray(r.quantity_breaks) ? r.quantity_breaks : [];
  const maxVol = Math.max(0, ...breaks.map((b) => Number(b.discount_pct ?? 0)));
  const maxQty = breaks.filter((b) => Number(b.discount_pct) === maxVol).map((b) => Number(b.quantity)).sort((a, b) => a - b)[0] ?? 3;
  const maxCompound = Math.round((1 - (1 - sns / 100) * (1 - maxVol / 100)) * 100); // SnS × volume, compounded

  // Representative single-unit variant (fewest servings) → MSRP + servings for the per-serving math.
  const priced = variants.map((v) => ({ price: Number(v.price_cents ?? 0), servings: Number(v.servings ?? 0) })).filter((v) => v.price > 0 && v.servings > 0);
  const single = priced.sort((a, b) => a.servings - b.servings)[0] ?? null;
  const msrpCents = single?.price ?? null;
  const servingsPerUnit = single?.servings ?? null;
  const discountedUnitCents = msrpCents != null ? Math.round(msrpCents * (1 - maxCompound / 100)) : null;
  const perServingCents = discountedUnitCents != null && servingsPerUnit ? Math.round(discountedUnitCents / servingsPerUnit) : null;

  const parts: string[] = [];
  if (sns) parts.push(`${sns}% Subscribe & Save`);
  if (maxVol) parts.push(`up to ${maxVol}% for ${maxQty}+ units`);
  const headline = `Up to ${maxCompound}% off${r.free_shipping ? " + free shipping" : ""}${parts.length ? ` (${parts.join(" + ")})` : ""}`;
  const disclaimer = [maxVol ? `${maxQty}+ units` : null, sns ? "on Subscribe & Save" : null].filter(Boolean).join(" ");

  return { subscribeDiscountPct: sns, freeShipping: !!r.free_shipping, quantityBreaks: breaks, maxCompoundDiscountPct: maxCompound, headline, msrpCents, discountedUnitCents, servingsPerUnit, perServingCents, disclaimer };
}

/** Resolve a product by handle (e.g. "amazing-coffee") → its `products.id`, for callers that only know the slug. */
export async function resolveProductIdByHandle(admin: Admin, workspaceId: string, handle: string): Promise<string | null> {
  const { data } = await admin.from("products").select("id").eq("workspace_id", workspaceId).eq("handle", handle).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
