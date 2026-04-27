import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: Contextual KB articles for widget — no auth required
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const url = new URL(request.url);
  const productIdRaw = url.searchParams.get("pid") || "";
  const productHandle = url.searchParams.get("handle") || "";
  const search = url.searchParams.get("search") || "";
  const pagePath = url.searchParams.get("path") || "";

  const admin = createAdminClient();

  // Resolve `pid` — accepts either our internal UUID or Shopify product ID.
  // Storefront passes the internal UUID (Shopify-deprecation-friendly); legacy
  // embeds pass the Shopify ID. Normalize to shopify_product_id for the rest of
  // this route since knowledge_base.product_id matches against shopify ids.
  let productId = productIdRaw;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productIdRaw);
  if (isUuid) {
    const { data: prod } = await admin.from("products")
      .select("shopify_product_id")
      .eq("workspace_id", workspaceId)
      .eq("id", productIdRaw)
      .maybeSingle();
    productId = prod?.shopify_product_id || "";
  }

  // Verify workspace exists
  const { data: ws } = await admin
    .from("workspaces")
    .select("id, help_slug")
    .eq("id", workspaceId)
    .single();
  if (!ws) return NextResponse.json({ articles: [] });

  // If searching, do a text search
  if (search) {
    let query = admin
      .from("knowledge_base")
      .select("id, title, slug, excerpt, category, product_id, product_name, view_count, helpful_yes")
      .eq("workspace_id", workspaceId)
      .eq("published", true)
      .eq("active", true)
      .or(`title.ilike.%${search}%,content.ilike.%${search}%`)
      .order("view_count", { ascending: false })
      .limit(10);

    // Boost current product in results — fetch product articles separately and merge
    if (productId || productHandle) {
      const { data: allResults } = await query;

      // Find the product in our products table
      let shopifyProductId = productId;
      if (!shopifyProductId && productHandle) {
        const { data: product } = await admin
          .from("products")
          .select("shopify_product_id")
          .eq("workspace_id", workspaceId)
          .eq("handle", productHandle)
          .single();
        shopifyProductId = product?.shopify_product_id || "";
      }

      if (shopifyProductId && allResults) {
        // Sort: product-related articles first
        const sorted = [...allResults].sort((a, b) => {
          const aMatch = a.product_name ? 1 : 0;
          const bMatch = b.product_name ? 1 : 0;
          return bMatch - aMatch;
        });
        return NextResponse.json({ articles: sorted, help_slug: ws.help_slug });
      }

      return NextResponse.json({ articles: allResults || [], help_slug: ws.help_slug });
    }

    const { data: results } = await query;
    return NextResponse.json({ articles: results || [], help_slug: ws.help_slug });
  }

  // Check path mappings for category context
  let pathCategory: string | null = null;
  if (pagePath) {
    const { data: mappings } = await admin
      .from("widget_path_mappings")
      .select("path, match_type, category")
      .eq("workspace_id", workspaceId);

    for (const m of mappings || []) {
      if (m.match_type === "exact" && pagePath === m.path) {
        pathCategory = m.category;
        break;
      }
      if (m.match_type === "prefix" && pagePath.startsWith(m.path)) {
        pathCategory = m.category;
        break;
      }
    }
  }

  // No search — return contextual articles
  // If on a product page, show product-specific articles first
  let productArticles: typeof articles = [];
  let articles: { id: string; title: string; slug: string; excerpt: string | null; category: string; product_id: string | null; product_name: string | null; view_count: number; helpful_yes: number }[] = [];

  // Path-category articles
  if (pathCategory && !productId && !productHandle) {
    const { data: catArticles } = await admin
      .from("knowledge_base")
      .select("id, title, slug, excerpt, category, product_id, product_name, view_count, helpful_yes")
      .eq("workspace_id", workspaceId)
      .eq("published", true)
      .eq("active", true)
      .eq("category", pathCategory)
      .order("view_count", { ascending: false })
      .limit(5);
    if (catArticles?.length) {
      productArticles = catArticles;
    }
  }

  if (productId || productHandle) {
    // Find product (also fetch the merchant's hand-picked featured articles)
    let dbProductId: string | null = null;
    let featuredIds: string[] = [];
    if (productId) {
      const { data: product } = await admin
        .from("products")
        .select("id, featured_widget_article_ids")
        .eq("workspace_id", workspaceId)
        .eq("shopify_product_id", productId)
        .single();
      dbProductId = product?.id || null;
      featuredIds = (product?.featured_widget_article_ids as string[]) || [];
    } else if (productHandle) {
      const { data: product } = await admin
        .from("products")
        .select("id, featured_widget_article_ids")
        .eq("workspace_id", workspaceId)
        .eq("handle", productHandle)
        .single();
      dbProductId = product?.id || null;
      featuredIds = (product?.featured_widget_article_ids as string[]) || [];
    }

    if (dbProductId) {
      // 1. Pinned/featured articles (merchant-curated, sales-focused) — order preserved
      let featured: typeof articles = [];
      if (featuredIds.length) {
        const { data: f } = await admin
          .from("knowledge_base")
          .select("id, title, slug, excerpt, category, product_id, product_name, view_count, helpful_yes")
          .eq("workspace_id", workspaceId)
          .eq("published", true)
          .eq("active", true)
          .in("id", featuredIds);
        // Preserve admin-defined order
        featured = featuredIds
          .map(id => (f || []).find(a => a.id === id))
          .filter((a): a is NonNullable<typeof a> => !!a);
      }

      // 2. Other product-tagged articles to fill out
      const need = Math.max(0, 5 - featured.length);
      let other: typeof articles = [];
      if (need > 0) {
        const { data: o } = await admin
          .from("knowledge_base")
          .select("id, title, slug, excerpt, category, product_id, product_name, view_count, helpful_yes")
          .eq("workspace_id", workspaceId)
          .eq("published", true)
          .eq("active", true)
          .eq("product_id", dbProductId)
          .not("id", "in", `(${featured.map(a => `"${a.id}"`).join(",") || `""`})`)
          .order("view_count", { ascending: false })
          .limit(need);
        other = o || [];
      }

      productArticles = [...featured, ...other];
    }
  }

  // Fill remaining slots with most viewed articles
  const productArticleIds = productArticles.map(a => a.id);
  const remaining = 5 - productArticles.length;

  if (remaining > 0) {
    let query = admin
      .from("knowledge_base")
      .select("id, title, slug, excerpt, category, product_id, product_name, view_count, helpful_yes")
      .eq("workspace_id", workspaceId)
      .eq("published", true)
      .eq("active", true)
      .order("view_count", { ascending: false })
      .limit(remaining + productArticleIds.length); // fetch extra to filter

    const { data: popular } = await query;
    const filtered = (popular || []).filter(a => !productArticleIds.includes(a.id));
    articles = [...productArticles, ...filtered.slice(0, remaining)];
  } else {
    articles = productArticles;
  }

  return NextResponse.json({ articles, help_slug: ws.help_slug });
}
