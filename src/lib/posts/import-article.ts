/**
 * Import + classify a Shopify blog article into our `posts` object
 * (spec: blog-resources). Idempotent on (workspace_id, shopify_article_id).
 *
 *   1. (caller pulls the article via the Admin API — fetchBlogArticles)
 *   2. classifyArticle: AI decides is_resource + which product(s) + grouping
 *   3. migratePostImages: move images off Shopify → our storage
 *   4. upsert posts + replace post_products
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { migratePostImages } from "@/lib/posts/migrate-images";

const SONNET_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const GROUPINGS = ["recipes", "how_it_works", "how_to_use", "science", "general"] as const;
export type Grouping = (typeof GROUPINGS)[number];

export interface RawArticle {
  shopifyArticleId: string;
  blogHandle: string;
  handle: string;
  title: string;
  contentHtml: string;
  excerpt: string | null;
  featuredImageUrl: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  tags: string[];
  publishedAt: string | null;
}

interface ProductRef { id: string; title: string; handle: string }

/** Remove Shopify's editor cruft (meta/base tags, comments) from a body. */
export function cleanBodyHtml(html: string): string {
  return (html || "")
    .replace(/<meta[^>]*>/gi, "")
    .replace(/<base[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

/** A clean plain-text excerpt (≤240 chars) from the summary, else the body. */
export function cleanExcerpt(rawSummary: string | null, contentText: string): string {
  const fromSummary = htmlToText(rawSummary || "");
  return (fromSummary.length > 10 ? fromSummary : contentText).slice(0, 240).trim();
}

/** Strip HTML → plain text for search + classification. */
export function htmlToText(html: string): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The real sellable products to classify against (exclude shipping/mystery). */
async function loadProductCatalog(workspaceId: string): Promise<ProductRef[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("products")
    .select("id, title, handle")
    .eq("workspace_id", workspaceId);
  return (data || [])
    .filter((p) => !/shipping|mystery/i.test(String(p.handle || "")) && !/shipping protection|mystery item/i.test(String(p.title || "")))
    .map((p) => ({ id: p.id as string, title: p.title as string, handle: p.handle as string }));
}

export interface Classification {
  is_resource: boolean;
  product_ids: string[];
  grouping: Grouping | null;
  confidence: number;
}

/**
 * AI classification. Given the article + the product catalog, decide whether
 * it's a product resource, which product(s) it's about (inferred — articles
 * aren't tagged), and which grouping. Falls back to blog-only on any failure.
 */
export async function classifyArticle(
  workspaceId: string,
  article: { title: string; contentText: string },
  catalog?: ProductRef[],
): Promise<Classification> {
  const products = catalog || (await loadProductCatalog(workspaceId));
  if (!ANTHROPIC_API_KEY) return { is_resource: false, product_ids: [], grouping: null, confidence: 0 };

  const productList = products.map((p) => `- ${p.handle}: ${p.title}`).join("\n");
  const system =
    `You classify a brand's blog article. Decide:\n` +
    `1. is_resource: true if it's a useful RESOURCE for a specific product (a recipe using it, how it works / the science behind it, how to use it). false if it's a general lifestyle/seasonal/marketing post not tied to a product.\n` +
    `2. products: the product HANDLE(s) the article is about — infer from the title + content (articles are NOT tagged). Empty if not product-specific. A post can map to multiple products.\n` +
    `3. grouping: one of "recipes" (a recipe/how-to-make), "how_it_works" (mechanism/science/ingredients/benefits), "how_to_use" (usage instructions/tips), "science" (clinical studies/research), "general" (fallback). Null if not a resource.\n\n` +
    `Products:\n${productList}\n\n` +
    `Reply ONLY compact JSON: {"is_resource": bool, "products": ["handle", ...], "grouping": "<one>"|null, "confidence": 0-1}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 300,
        system,
        messages: [{ role: "user", content: `Title: ${article.title}\n\nContent:\n${article.contentText.slice(0, 8000)}` }],
      }),
    });
    if (!res.ok) return { is_resource: false, product_ids: [], grouping: null, confidence: 0 };
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = json.content?.[0]?.text?.trim() || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { is_resource: false, product_ids: [], grouping: null, confidence: 0 };
    const parsed = JSON.parse(match[0]) as { is_resource?: boolean; products?: string[]; grouping?: string; confidence?: number };

    const handleToId = new Map(products.map((p) => [p.handle, p.id]));
    const product_ids = (parsed.products || []).map((h) => handleToId.get(h)).filter((x): x is string => !!x);
    const grouping = GROUPINGS.includes(parsed.grouping as Grouping) ? (parsed.grouping as Grouping) : null;
    const isResource = !!parsed.is_resource && product_ids.length > 0;
    return {
      is_resource: isResource,
      product_ids: isResource ? product_ids : [],
      grouping: isResource ? (grouping || "general") : null,
      confidence: Number(parsed.confidence) || 0,
    };
  } catch (e) {
    console.warn("[classify] failed:", e instanceof Error ? e.message : e);
    return { is_resource: false, product_ids: [], grouping: null, confidence: 0 };
  }
}

export interface ImportResult {
  postId: string;
  title: string;
  is_resource: boolean;
  product_ids: string[];
  grouping: Grouping | null;
  imagesMigrated: number;
}

/** Full per-article import: classify → migrate images → upsert. Idempotent. */
export async function importBlogArticle(
  workspaceId: string,
  article: RawArticle,
  catalog?: ProductRef[],
): Promise<ImportResult> {
  const admin = createAdminClient();
  const contentText = htmlToText(article.contentHtml);

  const classification = await classifyArticle(workspaceId, { title: article.title, contentText }, catalog);
  const images = await migratePostImages(workspaceId, article.handle, article.contentHtml, article.featuredImageUrl);
  const cleanHtml = cleanBodyHtml(images.html);
  const excerpt = cleanExcerpt(article.excerpt, contentText);

  const { data: post, error } = await admin
    .from("posts")
    .upsert(
      {
        workspace_id: workspaceId,
        shopify_article_id: article.shopifyArticleId,
        blog_handle: article.blogHandle,
        handle: article.handle,
        title: article.title,
        excerpt,
        content_html: cleanHtml,
        content_text: contentText,
        featured_image_url: images.featuredImageUrl,
        seo_title: article.seoTitle,
        seo_description: article.seoDescription,
        tags: article.tags || [],
        is_resource: classification.is_resource,
        grouping: classification.grouping,
        published: true,
        published_at: article.publishedAt,
        source: "shopify_blog",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,shopify_article_id" },
    )
    .select("id")
    .single();
  if (error || !post) throw new Error(`posts upsert failed: ${error?.message}`);
  const postId = post.id as string;

  // Replace product links.
  await admin.from("post_products").delete().eq("post_id", postId);
  if (classification.product_ids.length) {
    await admin.from("post_products").insert(
      classification.product_ids.map((product_id) => ({ workspace_id: workspaceId, post_id: postId, product_id })),
    );
  }

  return {
    postId,
    title: article.title,
    is_resource: classification.is_resource,
    product_ids: classification.product_ids,
    grouping: classification.grouping,
    imagesMigrated: images.migratedCount,
  };
}

/** Pull all articles from the workspace's Shopify blog(s) via the Admin API. */
export async function fetchBlogArticles(workspaceId: string): Promise<RawArticle[]> {
  const { getShopifyCredentials } = await import("@/lib/shopify-sync");
  const creds = await getShopifyCredentials(workspaceId);
  if (!creds) throw new Error("Shopify not configured");
  const { shop, accessToken } = creds;
  // Article has no top-level `seo` field — SEO title/description live in the
  // `global.title_tag` / `global.description_tag` metafields.
  const query = `{
    articles(first: 100, reverse: true) {
      nodes {
        id title handle publishedAt tags summary body
        image { url }
        blog { handle }
        metafields(first: 10, namespace: "global") { nodes { key value } }
      }
    }
  }`;
  const res = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as { data?: { articles?: { nodes?: Array<Record<string, unknown>> } }; errors?: unknown };
  if (json.errors || !json.data?.articles) throw new Error(`Shopify articles fetch failed: ${JSON.stringify(json.errors)}`);
  return (json.data.articles.nodes || []).map((a) => {
    const mfs = ((a.metafields as { nodes?: Array<{ key: string; value: string }> } | undefined)?.nodes) || [];
    const mf = (key: string) => mfs.find((m) => m.key === key)?.value || null;
    return {
      shopifyArticleId: String(a.id),
      blogHandle: String((a.blog as Record<string, unknown> | undefined)?.handle || ""),
      handle: String(a.handle || ""),
      title: String(a.title || ""),
      contentHtml: String(a.body || ""),
      excerpt: (a.summary as string) || null,
      featuredImageUrl: ((a.image as Record<string, unknown> | undefined)?.url as string) || null,
      seoTitle: mf("title_tag"),
      seoDescription: mf("description_tag"),
      tags: (a.tags as string[]) || [],
      publishedAt: (a.publishedAt as string) || null,
    };
  });
}
