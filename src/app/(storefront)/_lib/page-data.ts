/**
 * Storefront page data loader.
 *
 * Single function called at build time (SSG) and on ISR revalidation to
 * pull everything a product landing page needs in one shot. All queries
 * run in parallel. Uses the admin client; RLS is wide open on the
 * storefront-related tables (see 20260420000003_storefront_tables.sql).
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface Product {
  id: string;
  workspace_id: string;
  handle: string;
  title: string;
  image_url: string | null;
  description: string | null;
  rating: number | null;
  rating_count: number | null;
  target_customer: string | null;
  certifications: string[] | null;
  intelligence_status: string | null;
  variants: Array<{
    id?: string;
    title?: string;
    sku?: string;
    price_cents?: number;
    image_url?: string | null;
  }> | null;
}

export interface PageContent {
  id: string;
  hero_headline: string | null;
  hero_subheadline: string | null;
  benefit_bar: Array<{ icon_hint?: string; text: string }>;
  mechanism_copy: string | null;
  ingredient_cards: Array<{
    name: string;
    headline: string;
    body: string;
    confidence?: number;
    image_slot?: string;
  }>;
  comparison_table_rows: Array<{
    feature: string;
    us: string;
    competitor_generic: string;
  }>;
  faq_items: Array<{ question: string; answer: string }>;
  guarantee_copy: string | null;
  fda_disclaimer: string;
  knowledge_base_article: string | null;
  kb_what_it_doesnt_do: string | null;
}

export interface Ingredient {
  id: string;
  name: string;
  dosage_display: string | null;
  display_order: number;
}

export interface IngredientResearch {
  id: string;
  ingredient_id: string;
  benefit_headline: string;
  mechanism_explanation: string;
  dosage_comparison: string | null;
  ai_confidence: number;
  citations: Array<Record<string, unknown>>;
}

export interface BenefitSelection {
  id: string;
  benefit_name: string;
  role: "lead" | "supporting" | "skip";
  display_order: number;
  customer_phrases: string[] | null;
}

export interface PricingTier {
  id: string;
  variant_id: string;
  tier_name: string;
  quantity: number;
  price_cents: number;
  subscribe_price_cents: number | null;
  subscribe_discount_pct: number | null;
  per_unit_cents: number | null;
  badge: string | null;
  is_highlighted: boolean;
  display_order: number;
}

export interface HowItWorksStep {
  id: string;
  step_number: number;
  icon_hint: string | null;
  headline: string;
  body: string;
  display_order: number;
}

export interface MediaItem {
  slot: string;
  url: string | null;
  webp_url: string | null;
  avif_url: string | null;
  avif_640_url: string | null;
  webp_640_url: string | null;
  avif_1200_url: string | null;
  webp_1200_url: string | null;
  avif_1920_url: string | null;
  webp_1920_url: string | null;
  alt_text: string | null;
}

/**
 * Pick the best-compressed URL available. AVIF > WebP > original.
 * Non-hero images feed this into `next/image`, which runs its own
 * optimizer + cache layer. The hero uses pictureSources() instead,
 * which routes through the edge proxy for cold-cache-proof delivery.
 */
export function bestMediaUrl(m: MediaItem | null | undefined): string | null {
  if (!m) return null;
  return m.avif_url || m.webp_url || m.url || null;
}

export interface Review {
  id: string;
  reviewer_name: string | null;
  rating: number | null;
  title: string | null;
  body: string | null;
  images: string[] | null;
  smart_quote: string | null;
  created_at: string;
  status: string;
}

export interface ReviewAnalysis {
  top_benefits: Array<{ benefit: string; frequency: number; customer_phrases?: string[] }> | null;
  skeptic_conversions: Array<{ summary: string; quote: string; reviewer_name?: string }> | null;
  most_powerful_phrases: Array<{ phrase: string; reviewer_name?: string }> | null;
  reviews_analyzed_count: number;
}

export interface BenefitAngleOverride {
  benefit_key: string;
  hero_headline: string | null;
  hero_subheadline: string | null;
  featured_ingredient_ids: string[] | null;
  lead_review_keywords: string[] | null;
  comparison_row_order: number[] | null;
  faq_priority_ids: string[] | null;
}

export interface PageData {
  product: Product;
  page_content: PageContent | null;
  ingredients: Ingredient[];
  ingredient_research: IngredientResearch[];
  benefit_selections: BenefitSelection[];
  pricing_tiers: PricingTier[];
  how_it_works: HowItWorksStep[];
  media_by_slot: Record<string, MediaItem>;
  reviews: Review[];
  review_analysis: ReviewAnalysis | null;
  review_total_count: number;
  benefit_angle: BenefitAngleOverride | null;
  workspace: {
    id: string;
    storefront_slug: string | null;
    storefront_domain: string | null;
    shopify_myshopify_domain: string | null;
    support_email: string | null;
    design: {
      font_key: string | null;
      primary_color: string | null;
      accent_color: string | null;
      logo_url: string | null;
    };
  };
}

/**
 * Resolve a workspace by storefront_slug. Falls back to null if not
 * found (page.tsx returns 404).
 */
export async function getWorkspaceBySlug(slug: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select(
      "id, storefront_slug, storefront_domain, shopify_myshopify_domain, support_email, storefront_font, storefront_primary_color, storefront_accent_color, storefront_logo_url",
    )
    .eq("storefront_slug", slug)
    .maybeSingle();
  return data;
}

/**
 * Load every piece of data a storefront page needs for one product.
 * Returns null if the product doesn't exist, isn't published, or the
 * workspace can't be resolved.
 */
export async function getPageData(
  workspaceSlug: string,
  productHandle: string,
  opts: { benefitKey?: string } = {},
): Promise<PageData | null> {
  const admin = createAdminClient();

  const workspace = await getWorkspaceBySlug(workspaceSlug);
  if (!workspace) return null;

  const { data: product } = await admin
    .from("products")
    .select(
      "id, workspace_id, handle, title, image_url, description, rating, rating_count, target_customer, certifications, intelligence_status, variants",
    )
    .eq("workspace_id", workspace.id)
    .eq("handle", productHandle)
    .maybeSingle();

  if (!product) return null;

  // Everything else in parallel
  const [
    pageContentRes,
    ingredientsRes,
    researchRes,
    benefitSelectionsRes,
    pricingTiersRes,
    howItWorksRes,
    mediaRes,
    reviewAnalysisRes,
    reviewCountRes,
    benefitAngleRes,
  ] = await Promise.all([
    admin
      .from("product_page_content")
      .select(
        "id, hero_headline, hero_subheadline, benefit_bar, mechanism_copy, ingredient_cards, comparison_table_rows, faq_items, guarantee_copy, fda_disclaimer, knowledge_base_article, kb_what_it_doesnt_do, status, version",
      )
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .eq("status", "published")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("product_ingredients")
      .select("id, name, dosage_display, display_order")
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .order("display_order"),
    admin
      .from("product_ingredient_research")
      .select(
        "id, ingredient_id, benefit_headline, mechanism_explanation, dosage_comparison, ai_confidence, citations",
      )
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id),
    admin
      .from("product_benefit_selections")
      .select("id, benefit_name, role, display_order, customer_phrases")
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .in("role", ["lead", "supporting"])
      .order("display_order"),
    admin
      .from("product_pricing_tiers")
      .select(
        "id, variant_id, tier_name, quantity, price_cents, subscribe_price_cents, subscribe_discount_pct, per_unit_cents, badge, is_highlighted, display_order",
      )
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .order("display_order"),
    admin
      .from("product_how_it_works")
      .select("id, step_number, icon_hint, headline, body, display_order")
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .order("display_order"),
    admin
      .from("product_media")
      .select(
        "slot, url, webp_url, avif_url, avif_640_url, webp_640_url, avif_1200_url, webp_1200_url, avif_1920_url, webp_1920_url, alt_text",
      )
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id),
    admin
      .from("product_review_analysis")
      .select(
        "top_benefits, skeptic_conversions, most_powerful_phrases, reviews_analyzed_count",
      )
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .maybeSingle(),
    admin
      .from("product_reviews")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .in("status", ["published", "featured"]),
    opts.benefitKey
      ? admin
          .from("product_benefit_angles")
          .select(
            "benefit_key, hero_headline, hero_subheadline, featured_ingredient_ids, lead_review_keywords, comparison_row_order, faq_priority_ids",
          )
          .eq("workspace_id", workspace.id)
          .eq("product_id", product.id)
          .eq("benefit_key", opts.benefitKey)
          .eq("is_active", true)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // Product reviews are keyed by shopify_product_id. The placeholder query
  // above returns nothing — re-fetch with the proper key now that we have
  // the product loaded. Kept inline (not in the parallel block) so we can
  // reference product fields.
  const { data: reviews } = await admin
    .from("product_reviews")
    .select(
      "id, reviewer_name, rating, title, body, images, smart_quote, created_at, status",
    )
    .eq("workspace_id", workspace.id)
    .eq("shopify_product_id", extractShopifyProductId(product))
    .in("status", ["published", "featured"])
    .not("body", "is", null)
    .order("rating", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(24);

  const { count: reviewTotalCount } = await admin
    .from("product_reviews")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace.id)
    .eq("shopify_product_id", extractShopifyProductId(product))
    .in("status", ["published", "featured"]);

  const mediaBySlot: Record<string, MediaItem> = {};
  for (const m of mediaRes.data || []) {
    const row = m as Record<string, string | null>;
    mediaBySlot[m.slot] = {
      slot: m.slot,
      url: m.url,
      webp_url: row.webp_url ?? null,
      avif_url: row.avif_url ?? null,
      avif_640_url: row.avif_640_url ?? null,
      webp_640_url: row.webp_640_url ?? null,
      avif_1200_url: row.avif_1200_url ?? null,
      webp_1200_url: row.webp_1200_url ?? null,
      avif_1920_url: row.avif_1920_url ?? null,
      webp_1920_url: row.webp_1920_url ?? null,
      alt_text: m.alt_text,
    };
  }
  void reviewCountRes;

  return {
    product: product as Product,
    page_content: (pageContentRes.data as PageContent | null) || null,
    ingredients: (ingredientsRes.data || []) as Ingredient[],
    ingredient_research: (researchRes.data || []) as IngredientResearch[],
    benefit_selections: (benefitSelectionsRes.data || []) as BenefitSelection[],
    pricing_tiers: (pricingTiersRes.data || []) as PricingTier[],
    how_it_works: (howItWorksRes.data || []) as HowItWorksStep[],
    media_by_slot: mediaBySlot,
    reviews: (reviews || []) as Review[],
    review_analysis: (reviewAnalysisRes.data as ReviewAnalysis | null) || null,
    review_total_count: reviewTotalCount || 0,
    benefit_angle: (benefitAngleRes.data as BenefitAngleOverride | null) || null,
    workspace: {
      id: workspace.id,
      storefront_slug: workspace.storefront_slug,
      storefront_domain: workspace.storefront_domain,
      shopify_myshopify_domain: workspace.shopify_myshopify_domain,
      support_email: workspace.support_email,
      design: {
        font_key: workspace.storefront_font || null,
        primary_color: workspace.storefront_primary_color || null,
        accent_color: workspace.storefront_accent_color || null,
        logo_url: workspace.storefront_logo_url || null,
      },
    },
  };
}

// The `products` row stores `shopify_product_id` as a top-level column
// (added in Phase 2 sync). Local variable helps Typescript narrow.
function extractShopifyProductId(p: Product & { shopify_product_id?: string }): string {
  return (p as { shopify_product_id?: string }).shopify_product_id || "";
}

/**
 * List every (workspace_slug, product_handle) pair that should be
 * statically generated. Returns an empty array if nothing is ready yet
 * — Next build will still succeed.
 */
export async function listPublishedProducts(): Promise<
  Array<{ workspace: string; slug: string }>
> {
  const admin = createAdminClient();
  const { data: workspaces } = await admin
    .from("workspaces")
    .select("id, storefront_slug")
    .not("storefront_slug", "is", null);

  const params: Array<{ workspace: string; slug: string }> = [];
  for (const ws of workspaces || []) {
    if (!ws.storefront_slug) continue;
    const { data: products } = await admin
      .from("products")
      .select("handle")
      .eq("workspace_id", ws.id)
      .eq("intelligence_status", "published");
    for (const p of products || []) {
      if (!p.handle) continue;
      params.push({ workspace: ws.storefront_slug, slug: p.handle });
    }
  }
  return params;
}
