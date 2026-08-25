/**
 * Public, CORS-enabled per-product reviews feed for EXTERNAL surfaces — the
 * Shopify theme's DR review widgets, which replace the Klaviyo Reviews app
 * blocks retired in the Klaviyo sunset ([[../../../../../../docs/brain/integrations/klaviyo]]).
 *
 * `GET ?shopify_product_id=7465708093613&limit=12&offset=0`
 *   → { aggregate: { rating, count }, reviews: [...], has_more }
 *
 * **Keyed by Shopify product id, not handle.** Our `products.handle` and the
 * Shopify handle drift (ours says `amazing-coffee-pods`, Shopify's template is
 * `amazing-coffee-kcups`), and the theme always knows `{{ product.id }}`
 * exactly. `?handle=` is accepted as a fallback for surfaces that only have one.
 *
 * **Why not reuse `[slug]/reviews`.** That route serves the in-house storefront:
 * it keys off OUR handle, has an id-list mode for pill clicks, and sets no CORS
 * headers. Giving the theme its own endpoint keeps the two surfaces from
 * constraining each other — same table, different contract.
 *
 * Three things it gets right that a naive query would not:
 *
 *   1. **Pooled link groups.** Reviews follow the format group (Instant ↔
 *      K-Cups) via [[../../../../../../docs/brain/tables/product_link_members]],
 *      so a K-Cups PDP shows the pooled set — matching what the in-house
 *      storefront does.
 *   2. **Orphaned Shopify products.** 1,027 reviews carry a
 *      `shopify_product_id` for a product that never made it into our
 *      `products` table — 246 of them are ACV Gummies, whose live PDP shows 214
 *      reviews today. Matching on `product_reviews.shopify_product_id` as well
 *      as the resolved `product_id` keeps that PDP from dropping to zero.
 *   3. **Aggregate over the whole pool, not the page.** The header stars must
 *      read the same number the Shopify `reviews.rating_count` metafield does
 *      (see [[../../../../../../docs/brain/libraries/shopify-review-metafields]]),
 *      or the PDP contradicts its own product card.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceBySlug } from "@/app/(storefront)/_lib/page-data";
import { shopifyIdsFoldingInto } from "@/lib/shopify-review-metafields";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
};

/** Body is required — a starred row with no words is not social proof. */
const REVIEW_COLS = "id, reviewer_name, rating, title, body, summary, created_at, featured";
const SHOWN_STATUSES = ["published", "featured"];

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspace: string }> },
) {
  const { workspace: workspaceSlug } = await params;
  const url = new URL(request.url);
  const shopifyProductId = (url.searchParams.get("shopify_product_id") || "").trim();
  const handle = (url.searchParams.get("handle") || "").trim();
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "12", 10)));

  const empty = { aggregate: { rating: null, count: 0 }, reviews: [], has_more: false };

  if (!shopifyProductId && !handle) {
    return NextResponse.json({ error: "shopify_product_id or handle required" }, { status: 400, headers: CORS });
  }

  const workspace = await getWorkspaceBySlug(workspaceSlug);
  if (!workspace) return NextResponse.json(empty, { status: 404, headers: CORS });

  const admin = createAdminClient();

  // Resolve the internal product (may legitimately not exist — see the ACV
  // case in the header; the shopify_product_id match below still finds them).
  const productQuery = admin
    .from("products")
    .select("id")
    .eq("workspace_id", workspace.id)
    .limit(1);
  const { data: product } = shopifyProductId
    ? await productQuery.eq("shopify_product_id", shopifyProductId).maybeSingle()
    : await productQuery.eq("handle", handle).maybeSingle();

  // Pool the format group (Instant ↔ K-Cups) when there is one.
  let productIds: string[] = product?.id ? [product.id] : [];
  if (product?.id) {
    const { data: membership } = await admin
      .from("product_link_members")
      .select("group_id")
      .eq("product_id", product.id)
      .limit(1)
      .maybeSingle();
    if (membership?.group_id) {
      const { data: siblings } = await admin
        .from("product_link_members")
        .select("product_id")
        .eq("group_id", membership.group_id);
      productIds = Array.from(new Set([product.id, ...(siblings || []).map((s) => s.product_id)]));
    }
  }

  // One `.or()` over the two match paths: the resolved internal product ids and
  // the raw Shopify id the review row carries. `.in()` inside `.or()` needs the
  // parenthesised list form.
  const matchClauses: string[] = [];
  if (productIds.length) matchClauses.push(`product_id.in.(${productIds.join(",")})`);
  if (shopifyProductId) {
    // Includes duplicate Shopify products that fold into this one (the
    // "(Free Gift)" listings) — same fold the metafield sync applies, so the
    // PDP header and the product card can never disagree.
    matchClauses.push(`shopify_product_id.in.(${shopifyIdsFoldingInto(shopifyProductId).join(",")})`);
  }
  if (!matchClauses.length) return NextResponse.json(empty, { headers: CORS });
  const matchFilter = matchClauses.join(",");

  const base = () =>
    admin
      .from("product_reviews")
      .select(REVIEW_COLS)
      .eq("workspace_id", workspace.id)
      .or(matchFilter)
      .in("status", SHOWN_STATUSES)
      .not("body", "is", null);

  // Star histogram via five head-only COUNTs rather than pulling the rating
  // column. PostgREST caps a plain select at 1000 rows, so summing fetched
  // ratings would silently average only the first 1000 of Superfood Tabs'
  // 3,158 — right count, wrong average. Head counts are exact and transfer
  // no rows.
  //
  // NO body filter here: a rating-only review still counts toward "4.8 from
  // 3,158 reviews". Requiring text would cut Superfood Tabs by ~300 and
  // contradict the `reviews.rating_count` metafield the product cards read.
  const starCount = (star: number) =>
    admin
      .from("product_reviews")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .or(matchFilter)
      .in("status", SHOWN_STATUSES)
      .eq("rating", star);

  // Listable = has a body. Pagination must count these, not the aggregate —
  // otherwise `has_more` stays true forever against rating-only rows the list
  // can never render.
  const listableCount = admin
    .from("product_reviews")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace.id)
    .or(matchFilter)
    .in("status", SHOWN_STATUSES)
    .not("body", "is", null);

  const [{ data: reviews }, { count: listable }, ...starResults] = await Promise.all([
    base()
      .order("featured", { ascending: false })
      .order("rating", { ascending: false })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1),
    listableCount,
    starCount(1),
    starCount(2),
    starCount(3),
    starCount(4),
    starCount(5),
  ]);

  let rated = 0;
  let weighted = 0;
  starResults.forEach((res, i) => {
    const n = res.count || 0;
    rated += n;
    weighted += n * (i + 1);
  });

  const aggregate = {
    rating: rated ? Math.round((weighted / rated) * 100) / 100 : null,
    count: rated,
  };

  const returned = (reviews || []).map((r) => ({
    id: r.id,
    reviewer_name: r.reviewer_name,
    rating: r.rating,
    title: r.title,
    // `summary` is the Haiku-shortened line; the widget wants the real words.
    body: r.body || r.summary,
    created_at: r.created_at,
    featured: r.featured,
  }));

  return NextResponse.json(
    { aggregate, reviews: returned, has_more: offset + returned.length < (listable || 0) },
    { headers: CORS },
  );
}
