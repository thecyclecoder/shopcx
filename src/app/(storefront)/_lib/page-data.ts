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
  is_bestseller: boolean;
  header_text: string | null;
  header_text_color: string | null;
  header_text_weight: string | null;
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
  endorsement_name: string | null;
  endorsement_title: string | null;
  endorsement_quote: string | null;
  endorsement_bullets: string[];
  expectation_timeline: Array<{ time_label: string; headline: string; body: string }>;
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

/**
 * Linked-products group surfaced to the storefront. The current product
 * is one of the members; `is_current=true` marks it. The hero format
 * toggle uses this directly — no extra fetches.
 */
export interface LinkMember {
  member_id: string;
  product_id: string;
  product_handle: string;
  product_title: string;
  shopify_product_id: string | null;      // for cross-member review pooling
  value: string;                          // toggle pill label, e.g. "Instant"
  display_order: number;
  is_current: boolean;
  hero_url: string | null;
  hero_avif_url: string | null;
  hero_webp_url: string | null;
  hero_width: number | null;
  hero_height: number | null;
  primary_variant_shopify_id: string | null;
  primary_variant_servings: number | null;
  primary_variant_servings_unit: string | null;
  rating: number | null;
  rating_count: number | null;
}
export interface LinkGroup {
  id: string;
  link_type: string;                       // "format" — could later be size, flavor, etc.
  name: string;                            // display label, e.g. "Coffee Format"
  members: LinkMember[];
  combined_rating: number | null;          // weighted avg across members
  combined_rating_count: number;           // sum across members
  combined_review_total_count: number;     // published+featured review row count, summed
}

export interface MediaItem {
  slot: string;
  url: string | null;
  webp_url: string | null;
  avif_url: string | null;
  avif_480_url: string | null;
  webp_480_url: string | null;
  avif_750_url: string | null;
  webp_750_url: string | null;
  avif_1080_url: string | null;
  webp_1080_url: string | null;
  avif_1500_url: string | null;
  webp_1500_url: string | null;
  avif_1920_url: string | null;
  webp_1920_url: string | null;
  alt_text: string | null;
  width: number | null;
  height: number | null;
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
  featured?: boolean | null;
  product_id?: string | null;
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

export interface RecentOrderForProof {
  first_name: string;
  last_initial: string;
  state: string;
  product_title: string;
  image_url: string | null;
}

export interface PageData {
  product: Product;
  page_content: PageContent | null;
  ingredients: Ingredient[];
  ingredient_research: IngredientResearch[];
  benefit_selections: BenefitSelection[];
  pricing_tiers: PricingTier[];
  how_it_works: HowItWorksStep[];
  recent_orders_for_proof: RecentOrderForProof[];
  media_by_slot: Record<string, MediaItem>;
  // For slots that support multiple images (currently the hero), all
  // items in display_order. The first item also lives in
  // media_by_slot[slot] for backward-compat with single-image slots.
  media_gallery_by_slot: Record<string, MediaItem[]>;
  // If this product is in a link group (e.g. format toggle: Instant ↔
  // K-Cups), the group's members + visual + variant data so the hero
  // toggle can swap inline without re-fetching.
  link_group: LinkGroup | null;
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
      favicon_url: string | null;
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
      "id, storefront_slug, storefront_domain, shopify_myshopify_domain, support_email, storefront_font, storefront_primary_color, storefront_accent_color, storefront_logo_url, storefront_favicon_url, storefront_off_platform_review_count",
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
      "id, workspace_id, handle, title, image_url, description, rating, rating_count, target_customer, certifications, intelligence_status, is_bestseller, header_text, header_text_color, header_text_weight, variants",
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
    linkGroup,
  ] = await Promise.all([
    admin
      .from("product_page_content")
      .select(
        "id, hero_headline, hero_subheadline, benefit_bar, mechanism_copy, ingredient_cards, comparison_table_rows, faq_items, guarantee_copy, fda_disclaimer, knowledge_base_article, kb_what_it_doesnt_do, endorsement_name, endorsement_title, endorsement_quote, endorsement_bullets, expectation_timeline, status, version",
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
        "slot, display_order, url, webp_url, avif_url, avif_480_url, webp_480_url, avif_750_url, webp_750_url, avif_1080_url, webp_1080_url, avif_1500_url, webp_1500_url, avif_1920_url, webp_1920_url, alt_text, width, height",
      )
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .order("display_order"),
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
    // Linked products (e.g. Instant ↔ K-Cups format toggle). Run in
    // parallel so we can pool reviews/ratings across members in the
    // same round trip rather than serializing two queries.
    loadLinkGroup(workspace.id, product.id),
  ]);

  // Product reviews now key off the internal product UUID (the
  // shopify_product_id column is sync-only metadata). For linked
  // products (e.g. Instant ↔ K-Cups), pool reviews across every member
  // of the link group so the featured-review carousel can serve the
  // strongest social proof regardless of which page the customer
  // landed on. Featured > rating > recency via the order clauses.
  const linkedProductIds = linkGroup
    ? linkGroup.members.map(m => m.product_id).filter(Boolean)
    : [];
  const reviewProductIds = Array.from(
    new Set(linkedProductIds.length ? [product.id, ...linkedProductIds] : [product.id]),
  );

  const { data: reviews } = await admin
    .from("product_reviews")
    .select(
      "id, reviewer_name, rating, title, body, images, smart_quote, created_at, status, featured, product_id",
    )
    .eq("workspace_id", workspace.id)
    .in("product_id", reviewProductIds)
    .in("status", ["published", "featured"])
    .not("body", "is", null)
    // Featured first (true > false), then highest rating, then newest.
    // The `featured` boolean is the canonical "this is hand-picked" flag
    // — sorting on `status` would sort alphabetically and bury them.
    .order("featured", { ascending: false })
    .order("rating", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(24);

  const { count: reviewTotalCount } = await admin
    .from("product_reviews")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace.id)
    .in("product_id", reviewProductIds)
    .in("status", ["published", "featured"]);

  const mediaBySlot: Record<string, MediaItem> = {};
  const mediaGalleryBySlot: Record<string, MediaItem[]> = {};
  for (const m of mediaRes.data || []) {
    const row = m as Record<string, string | number | null>;
    const item: MediaItem = {
      slot: m.slot,
      url: (row.url as string | null) ?? null,
      webp_url: (row.webp_url as string | null) ?? null,
      avif_url: (row.avif_url as string | null) ?? null,
      avif_480_url: (row.avif_480_url as string | null) ?? null,
      webp_480_url: (row.webp_480_url as string | null) ?? null,
      avif_750_url: (row.avif_750_url as string | null) ?? null,
      webp_750_url: (row.webp_750_url as string | null) ?? null,
      avif_1080_url: (row.avif_1080_url as string | null) ?? null,
      webp_1080_url: (row.webp_1080_url as string | null) ?? null,
      avif_1500_url: (row.avif_1500_url as string | null) ?? null,
      webp_1500_url: (row.webp_1500_url as string | null) ?? null,
      avif_1920_url: (row.avif_1920_url as string | null) ?? null,
      webp_1920_url: (row.webp_1920_url as string | null) ?? null,
      alt_text: (row.alt_text as string | null) ?? null,
      width: (row.width as number | null) ?? null,
      height: (row.height as number | null) ?? null,
    };
    // First row per slot wins for the singular media_by_slot map
    // (display_order=0). Append every row to the gallery list.
    if (!mediaBySlot[m.slot]) mediaBySlot[m.slot] = item;
    (mediaGalleryBySlot[m.slot] ??= []).push(item);
  }
  void reviewCountRes;

  // Reviews-elsewhere bump: we have reviews on Amazon and other channels
  // that aren't synced into product_reviews. The offset (configurable per
  // workspace via storefront_off_platform_review_count) is added to the
  // customer-facing counts so social proof reflects total volume. Per-product
  // star ratings themselves aren't touched — only counts.
  // Linked products (e.g. Instant ↔ K-Cups format toggle). When a
  // product is in a group, the customer-facing rating + count combines
  // across all members so the linked products read as one product. The
  // group itself was loaded in parallel above; this is just the bump.
  const reviewsBump = (workspace as { storefront_off_platform_review_count?: number | null }).storefront_off_platform_review_count || 0;
  const productWithBump = {
    ...(product as Product),
    // Apply link-group combined rating before the off-platform bump so
    // the bump still adds on top, just once per workspace.
    rating: linkGroup?.combined_rating ?? (product as Product).rating ?? null,
    rating_count: (linkGroup?.combined_rating_count ?? (product as Product).rating_count ?? 0) + reviewsBump,
  };
  const baseReviewTotal = linkGroup?.combined_review_total_count ?? (reviewTotalCount || 0);
  const totalCountWithBump = baseReviewTotal + reviewsBump;

  // Recent-orders social-proof toast data. Pull the last ~200 orders
  // in the workspace within 7 days, filter to those whose line_items
  // contain a variant from THIS product or any linked sibling product,
  // dedupe by customer, format names + state. SSG-time only — never
  // sent to the client beyond the formatted array.
  const recentOrdersForProof: RecentOrderForProof[] = [];
  try {
    const allProductIds = Array.from(new Set([product.id, ...linkedProductIds]));
    const { data: variants } = await admin
      .from("product_variants")
      .select("shopify_variant_id, product_id")
      .in("product_id", allProductIds);
    const variantToProduct = new Map<string, string>();
    const variantIds = new Set<string>();
    for (const v of variants || []) {
      if (v.shopify_variant_id) {
        variantIds.add(String(v.shopify_variant_id));
        variantToProduct.set(String(v.shopify_variant_id), String(v.product_id));
      }
    }

    // Build a per-product image map. Current product uses its own hero
    // (mediaBySlot["hero"]). Linked members carry their hero in
    // linkGroup.members[].hero_url.
    const productImageMap = new Map<string, string | null>();
    productImageMap.set(product.id, mediaBySlot["hero"]?.webp_480_url || mediaBySlot["hero"]?.url || null);
    const productTitleMap = new Map<string, string>();
    productTitleMap.set(product.id, product.title);
    if (linkGroup) {
      for (const m of linkGroup.members) {
        productImageMap.set(m.product_id, m.hero_webp_url || m.hero_url || null);
        productTitleMap.set(m.product_id, m.product_title || product.title);
      }
    }

    if (variantIds.size > 0) {
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data: orders } = await admin
        .from("orders")
        .select("id, created_at, line_items, shipping_address, customer_id")
        .eq("workspace_id", workspace.id)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(200);

      // First-pass: find matching orders + collect customer IDs
      type Match = { orderId: string; customerId: string; productId: string; ship: Record<string, string | null> | null };
      const matched: Match[] = [];
      for (const o of orders || []) {
        const items = (o.line_items as Array<{ variant_id?: string | number }>) || [];
        const hit = items.find((i) => i.variant_id != null && variantIds.has(String(i.variant_id)));
        if (!hit || !o.customer_id) continue;
        matched.push({
          orderId: String(o.id),
          customerId: String(o.customer_id),
          productId: variantToProduct.get(String(hit.variant_id)) || product.id,
          ship: (o.shipping_address as Record<string, string | null> | null) || null,
        });
        if (matched.length >= 60) break;
      }

      if (matched.length) {
        const { data: custs } = await admin
          .from("customers")
          .select("id, first_name, last_name")
          .in("id", Array.from(new Set(matched.map((m) => m.customerId))));
        const custMap = new Map((custs || []).map((c) => [String(c.id), c]));

        const seenCustomers = new Set<string>();
        for (const m of matched) {
          if (seenCustomers.has(m.customerId)) continue;
          const cust = custMap.get(m.customerId);
          if (!cust?.first_name) continue;
          const ship = m.ship || {};
          // Prefer the full state name. Shopify normally serves province as
          // the human-readable name and province_code as the 2-letter, but
          // older synced rows occasionally only have the code.
          const province = (ship.province as string | null) || null;
          const provinceCode = (ship.province_code as string | null) || null;
          const state = province || expandStateCode(provinceCode) || provinceCode || "";
          if (!state) continue;
          seenCustomers.add(m.customerId);
          recentOrdersForProof.push({
            first_name: String(cust.first_name).trim(),
            last_initial: ((cust.last_name as string | null) || "").trim().charAt(0).toUpperCase(),
            state,
            product_title: productTitleMap.get(m.productId) || product.title,
            image_url: productImageMap.get(m.productId) || null,
          });
          if (recentOrdersForProof.length >= 10) break;
        }
      }
    }
  } catch (err) {
    console.error("[page-data] recent_orders_for_proof load failed:", err);
  }

  return {
    product: productWithBump as Product,
    link_group: linkGroup,
    page_content: (pageContentRes.data as PageContent | null) || null,
    ingredients: (ingredientsRes.data || []) as Ingredient[],
    ingredient_research: (researchRes.data || []) as IngredientResearch[],
    benefit_selections: (benefitSelectionsRes.data || []) as BenefitSelection[],
    pricing_tiers: (pricingTiersRes.data || []) as PricingTier[],
    how_it_works: (howItWorksRes.data || []) as HowItWorksStep[],
    recent_orders_for_proof: recentOrdersForProof,
    media_by_slot: mediaBySlot,
    media_gallery_by_slot: mediaGalleryBySlot,
    reviews: (reviews || []) as Review[],
    review_analysis: (reviewAnalysisRes.data as ReviewAnalysis | null) || null,
    review_total_count: totalCountWithBump,
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
        favicon_url:
          (workspace as { storefront_favicon_url?: string | null }).storefront_favicon_url || null,
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
 * Load the link group this product belongs to (if any). Returns the
 * group + every member with their hero image, primary variant, and
 * combined rating math. The current product is marked is_current=true.
 *
 * Returns null when the product isn't a link member, or when the group
 * has only this single product (no toggle to render).
 */
async function loadLinkGroup(
  workspaceId: string,
  productId: string,
): Promise<LinkGroup | null> {
  const admin = await import("@/lib/supabase/admin").then(m => m.createAdminClient());

  // 1. Find the group(s) this product is a member of. We only render
  // one group at a time on the storefront; if a product is in multiple
  // groups (rare), use the first by created_at.
  const { data: myMembership } = await admin
    .from("product_link_members")
    .select("group_id, product_link_groups!inner(id, link_type, name, workspace_id, created_at)")
    .eq("product_id", productId)
    .order("group_id");
  if (!myMembership?.length) return null;

  const group = (myMembership[0] as unknown as {
    group_id: string;
    product_link_groups: { id: string; link_type: string; name: string; workspace_id: string };
  }).product_link_groups;
  if (!group || group.workspace_id !== workspaceId) return null;

  // 2. Fetch all members of this group + their basic product data
  const { data: rows } = await admin
    .from("product_link_members")
    .select("id, product_id, value, display_order")
    .eq("group_id", group.id)
    .order("display_order");
  const memberRows = rows || [];
  if (memberRows.length < 2) return null; // no toggle for single-product groups

  const memberProductIds = memberRows.map(m => m.product_id);

  // 3. Pull product data, hero media, primary variant in parallel
  const [{ data: products }, { data: media }, { data: variants }] = await Promise.all([
    admin.from("products")
      .select("id, handle, title, rating, rating_count, shopify_product_id")
      .in("id", memberProductIds),
    admin.from("product_media")
      .select("product_id, slot, display_order, url, webp_url, avif_url, avif_750_url, webp_750_url, width, height")
      .in("product_id", memberProductIds)
      .eq("slot", "hero")
      .order("display_order"),
    admin.from("product_variants")
      .select("product_id, shopify_variant_id, servings, servings_unit, position")
      .in("product_id", memberProductIds)
      .order("position"),
  ]);

  // 4. Build the per-member shape — pick the lowest-display_order hero +
  // the first (position 0) variant's servings as the "primary" for the
  // toggle's display.
  const productsById = new Map((products || []).map(p => [p.id, p]));
  type HeroRow = { product_id: string; url: string | null; avif_url: string | null; webp_url: string | null; width: number | null; height: number | null };
  const heroByProduct = new Map<string, HeroRow>();
  for (const m of (media || []) as HeroRow[]) {
    if (!heroByProduct.has(m.product_id)) heroByProduct.set(m.product_id, m);
  }
  const variantsByProduct = new Map<string, { shopify_variant_id: string | null; servings: number | null; servings_unit: string | null }>();
  for (const v of variants || []) {
    if (!variantsByProduct.has(v.product_id)) {
      variantsByProduct.set(v.product_id, {
        shopify_variant_id: v.shopify_variant_id,
        servings: v.servings,
        servings_unit: v.servings_unit,
      });
    }
  }

  const members: LinkMember[] = memberRows.map(m => {
    const p = productsById.get(m.product_id);
    const heroRow = heroByProduct.get(m.product_id);
    const variant = variantsByProduct.get(m.product_id);
    return {
      member_id: m.id,
      product_id: m.product_id,
      product_handle: (p as { handle?: string } | undefined)?.handle || "",
      product_title: (p as { title?: string } | undefined)?.title || "",
      shopify_product_id: (p as { shopify_product_id?: string } | undefined)?.shopify_product_id || null,
      value: m.value,
      display_order: m.display_order,
      is_current: m.product_id === productId,
      hero_url: heroRow?.url ?? null,
      hero_avif_url: heroRow?.avif_url ?? null,
      hero_webp_url: heroRow?.webp_url ?? null,
      hero_width: heroRow?.width ?? null,
      hero_height: heroRow?.height ?? null,
      primary_variant_shopify_id: variant?.shopify_variant_id || null,
      primary_variant_servings: variant?.servings ?? null,
      primary_variant_servings_unit: variant?.servings_unit ?? null,
      rating: (p as { rating?: number } | undefined)?.rating ?? null,
      rating_count: (p as { rating_count?: number } | undefined)?.rating_count ?? null,
    };
  });

  // 5. Combined rating math — weighted avg by rating_count
  let totalCount = 0;
  let weightedSum = 0;
  for (const m of members) {
    if (m.rating != null && m.rating_count != null && m.rating_count > 0) {
      weightedSum += m.rating * m.rating_count;
      totalCount += m.rating_count;
    }
  }
  const combinedRating = totalCount > 0 ? weightedSum / totalCount : null;

  // 6. Combined published-review row count across members. Joins on
  // the internal product UUID — see feedback_no_shopify_id_for_relationships.
  const memberProductIdsForCount = members.map(m => m.product_id).filter(Boolean);
  let combinedReviewTotalCount = 0;
  if (memberProductIdsForCount.length) {
    const { count } = await admin.from("product_reviews")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .in("product_id", memberProductIdsForCount)
      .in("status", ["published", "featured"]);
    combinedReviewTotalCount = count || 0;
  }

  return {
    id: group.id,
    link_type: group.link_type,
    name: group.name,
    members,
    combined_rating: combinedRating,
    combined_rating_count: totalCount,
    combined_review_total_count: combinedReviewTotalCount,
  };
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

/**
 * Expand a US/CA 2-letter state/province code to a human-readable
 * name. Returns null for codes we don't recognize (caller falls back
 * to the raw code).
 */
function expandStateCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const map: Record<string, string> = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
    CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
    KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
    MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
    NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
    ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
    RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
    TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
    WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "Washington, DC",
    AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
    NL: "Newfoundland", NS: "Nova Scotia", ON: "Ontario", PE: "Prince Edward Island",
    QC: "Quebec", SK: "Saskatchewan",
  };
  return map[code.toUpperCase()] || null;
}
