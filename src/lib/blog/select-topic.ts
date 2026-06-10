/**
 * Auto-blog topic selection (spec: auto-blog-generation).
 *
 * Picks the next post to write for a workspace: a product with published
 * intelligence, the least-covered category (archetype rotation), an
 * uncovered SEO keyword, and the persona that fits. Gathers the proprietary
 * intelligence (ingredients, research + real citations, review phrases,
 * benefits) the writer grounds the article in — this is what makes posts
 * read human, not scaled-AI.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { authorForArchetype, type BlogAuthor } from "@/lib/blog/authors";

export type Archetype = "recipe" | "how_it_works" | "how_to_use" | "science";
const ARCHETYPE_TO_GROUPING: Record<Archetype, string> = {
  recipe: "recipes",
  how_it_works: "how_it_works",
  how_to_use: "how_to_use",
  science: "science",
};
const ARCHETYPES: Archetype[] = ["recipe", "science", "how_it_works", "how_to_use"];

export interface TopicPlan {
  workspaceId: string;
  product: { id: string; handle: string; title: string; isolatedImageUrl: string };
  archetype: Archetype;
  grouping: string;
  targetKeyword: string;
  author: BlogAuthor;
  /** Proprietary intelligence the writer grounds the article in. */
  intelligence: {
    ingredients: string[];
    research: Array<{ headline: string; mechanism: string; citations: string[] }>;
    topBenefits: string[];
    customerPhrases: string[];
  };
  /** Titles already published for this product — the writer must not repeat. */
  existingTitles: string[];
}

/** Choose a topic for a workspace, or null if nothing eligible. */
export async function selectBlogTopic(workspaceId: string): Promise<TopicPlan | null> {
  const admin = createAdminClient();

  // Eligible products: published intelligence + an isolated variant image to composite.
  const { data: products } = await admin
    .from("products")
    .select("id, handle, title")
    .eq("workspace_id", workspaceId)
    .eq("intelligence_status", "published");
  if (!products?.length) return null;

  // Per product: existing AI posts (for least-recently-covered) + a usable variant image.
  type Candidate = TopicPlan["product"] & { postCount: number };
  const candidates: Candidate[] = [];
  for (const p of products) {
    const { data: variant } = await admin
      .from("product_variants")
      .select("image_url")
      .eq("product_id", p.id)
      .not("image_url", "is", null)
      .order("position")
      .limit(1)
      .maybeSingle();
    const isolated = variant?.image_url as string | undefined;
    // Only composite from our own storage (uploaded to shopcx), not Shopify CDN.
    if (!isolated || !isolated.includes("supabase.co")) continue;
    const { count } = await admin
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("source", "ai_generated")
      .in("id", (await postIdsForProduct(admin, workspaceId, p.id)));
    candidates.push({ id: p.id, handle: p.handle, title: p.title, isolatedImageUrl: isolated, postCount: count || 0 });
  }
  if (!candidates.length) return null;

  // Fewest AI posts first → round-robin coverage across products.
  candidates.sort((a, b) => a.postCount - b.postCount);
  const product = candidates[0];

  // Existing posts for this product → count by grouping + collect titles for dedup.
  const productPostIds = await postIdsForProduct(admin, workspaceId, product.id);
  const { data: existing } = productPostIds.length
    ? await admin.from("posts").select("title, grouping, tags").in("id", productPostIds)
    : { data: [] as Array<{ title: string; grouping: string | null; tags: string[] | null }> };
  const byGrouping = new Map<string, number>();
  const existingTitles: string[] = [];
  const coveredText: string[] = [];
  for (const e of existing || []) {
    if (e.grouping) byGrouping.set(e.grouping, (byGrouping.get(e.grouping) || 0) + 1);
    if (e.title) { existingTitles.push(e.title); coveredText.push(e.title.toLowerCase()); }
    for (const t of e.tags || []) coveredText.push(String(t).toLowerCase());
  }
  // Least-covered archetype.
  const archetype = [...ARCHETYPES].sort(
    (a, b) => (byGrouping.get(ARCHETYPE_TO_GROUPING[a]) || 0) - (byGrouping.get(ARCHETYPE_TO_GROUPING[b]) || 0),
  )[0];
  const grouping = ARCHETYPE_TO_GROUPING[archetype];

  // Target keyword: highest-signal SEO keyword not already obviously covered.
  const { data: keywords } = await admin
    .from("product_seo_keywords")
    .select("keyword, monthly_searches, is_selected")
    .eq("product_id", product.id)
    .order("is_selected", { ascending: false })
    .order("monthly_searches", { ascending: false, nullsFirst: false });
  const allKw = (keywords || []).map((k) => String(k.keyword || "")).filter(Boolean);
  const uncovered = allKw.filter((k) => !coveredText.some((c) => c.includes(k.toLowerCase())));
  const targetKeyword = uncovered[0] || allKw[0] || `${product.title} benefits`;

  // Intelligence bundle.
  const [ings, research, analysis, benefits] = await Promise.all([
    admin.from("product_ingredients").select("name").eq("product_id", product.id).order("display_order"),
    admin.from("product_ingredient_research").select("benefit_headline, mechanism_explanation, citations").eq("product_id", product.id).limit(40),
    admin.from("product_review_analysis").select("top_benefits, most_powerful_phrases").eq("product_id", product.id).maybeSingle(),
    admin.from("product_benefit_selections").select("customer_phrases").eq("product_id", product.id).in("role", ["lead", "supporting"]),
  ]);
  const citeTitle = (c: unknown): string => {
    const o = c as { title?: string; source?: string; url?: string };
    return (o?.title || o?.source || o?.url || "").toString();
  };
  const customerPhrases = Array.from(new Set([
    ...((analysis.data?.most_powerful_phrases as Array<{ phrase?: string }> | null) || []).map((p) => p.phrase || "").filter(Boolean),
    ...((benefits.data || []) as Array<{ customer_phrases: string[] | null }>).flatMap((b) => b.customer_phrases || []),
  ])).slice(0, 20);

  return {
    workspaceId,
    product,
    archetype,
    grouping,
    targetKeyword,
    author: authorForArchetype(archetype),
    intelligence: {
      ingredients: (ings.data || []).map((i) => String(i.name)).filter(Boolean),
      research: (research.data || []).map((r) => ({
        headline: String(r.benefit_headline || ""),
        mechanism: String(r.mechanism_explanation || "").slice(0, 300),
        citations: (Array.isArray(r.citations) ? r.citations : []).map(citeTitle).filter(Boolean).slice(0, 2),
      })).filter((r) => r.headline),
      topBenefits: ((analysis.data?.top_benefits as Array<{ benefit?: string }> | null) || []).map((b) => b.benefit || "").filter(Boolean),
      customerPhrases,
    },
    existingTitles,
  };
}

/** post ids linked to a product via post_products. */
async function postIdsForProduct(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  productId: string,
): Promise<string[]> {
  const { data } = await admin
    .from("post_products")
    .select("post_id")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);
  return (data || []).map((r) => String(r.post_id));
}
