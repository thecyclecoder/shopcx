import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceBySlug } from "@/app/(storefront)/_lib/page-data";

/**
 * One-shot reviews bootstrap. Components on the storefront mount and
 * fetch from here so reviews are fresh on every visit instead of waiting
 * on ISR. Returns:
 *   - featured: every truly-featured review (Klaviyo smart_featured) so
 *     the client can pick a random subset for the hero carousel and
 *     "Real people, real results" cards. Capped at 24 — there's never
 *     more than ~20-30 featured per product.
 *   - recent: top 30 published+featured by featured-first, rating,
 *     created_at — same ordering as the legacy SSG load, used as the
 *     "What customers are saying" initial list.
 *   - total: count of every published+featured row with a body
 *   - benefit_review_matches: { benefit_name -> review_id[] } across
 *     the full corpus. Pills filter against this map; clicks may need
 *     to lazy-fetch missing IDs via the /reviews?ids= endpoint.
 *   - reviews_by_product: count breakdown per linked product (debug
 *     only, useful in dashboard later).
 *
 * Edge-cached at 60s — review data rarely changes second-to-second,
 * and the underlying corpus scan is the heaviest server-side cost.
 */

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "with",
  "support", "supports", "health", "amp", "system",
]);
const meaningfulTokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspace: string; slug: string }> },
) {
  void request;
  const { workspace: workspaceSlug, slug } = await params;

  const workspace = await getWorkspaceBySlug(workspaceSlug);
  if (!workspace) {
    return NextResponse.json(
      { featured: [], recent: [], total: 0, benefit_review_matches: {} },
      { status: 404 },
    );
  }

  const admin = createAdminClient();

  const { data: product } = await admin
    .from("products")
    .select("id")
    .eq("workspace_id", workspace.id)
    .eq("handle", slug)
    .maybeSingle();
  if (!product?.id) {
    return NextResponse.json({
      featured: [],
      recent: [],
      total: 0,
      benefit_review_matches: {},
    });
  }

  // Resolve linked-product siblings so the review pool spans the whole
  // format group (Instant ↔ K-Cups, etc).
  const { data: linkMembership } = await admin
    .from("product_link_members")
    .select("group_id")
    .eq("product_id", product.id)
    .limit(1)
    .maybeSingle();
  let reviewProductIds: string[] = [product.id];
  if (linkMembership?.group_id) {
    const { data: siblings } = await admin
      .from("product_link_members")
      .select("product_id")
      .eq("group_id", linkMembership.group_id);
    reviewProductIds = Array.from(
      new Set([product.id, ...(siblings || []).map((s) => s.product_id)]),
    );
  }

  const reviewSelect =
    "id, reviewer_name, rating, title, body, images, smart_quote, created_at, status, featured, product_id";

  // Run all three queries in parallel.
  const [
    featuredRes,
    recentRes,
    totalRes,
    benefitSelectionsRes,
    analysisRes,
    corpusRes,
  ] = await Promise.all([
    admin
      .from("product_reviews")
      .select(reviewSelect)
      .eq("workspace_id", workspace.id)
      .in("product_id", reviewProductIds)
      .eq("featured", true)
      .not("body", "is", null)
      .order("rating", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(24),
    admin
      .from("product_reviews")
      .select(reviewSelect)
      .eq("workspace_id", workspace.id)
      .in("product_id", reviewProductIds)
      .in("status", ["published", "featured"])
      .not("body", "is", null)
      .order("featured", { ascending: false })
      .order("rating", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(30),
    admin
      .from("product_reviews")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .in("product_id", reviewProductIds)
      .in("status", ["published", "featured"])
      .not("body", "is", null),
    admin
      .from("product_benefit_selections")
      .select("benefit_name, role, customer_phrases")
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .in("role", ["lead", "supporting"])
      .order("display_order"),
    admin
      .from("product_review_analysis")
      .select("top_benefits")
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .maybeSingle(),
    // Full corpus for substring matching. Bodies stay server-side;
    // only the resulting ID lists ship to the client.
    admin
      .from("product_reviews")
      .select("id, body")
      .eq("workspace_id", workspace.id)
      .in("product_id", reviewProductIds)
      .in("status", ["published", "featured"])
      .not("body", "is", null),
  ]);

  // Build benefit_review_matches map
  const benefits = benefitSelectionsRes.data || [];
  const analysis = analysisRes.data as {
    top_benefits: Array<{ benefit: string; customer_phrases?: string[] }> | null;
  } | null;
  const corpus: Array<{ id: string; body: string }> = (corpusRes.data || []).map(
    (r) => ({ id: String(r.id), body: String(r.body || "").toLowerCase() }),
  );

  const benefit_review_matches: Record<string, string[]> = {};
  const topBenefits = analysis?.top_benefits || [];

  for (const b of benefits) {
    const phrases = new Set<string>();
    for (const p of b.customer_phrases || []) {
      if (p && typeof p === "string" && p.trim()) {
        phrases.add(p.trim().toLowerCase());
      }
    }
    const benefitTokens = new Set(meaningfulTokens(b.benefit_name));
    for (const tb of topBenefits) {
      const tbTokens = meaningfulTokens(tb.benefit || "");
      if (tbTokens.some((t) => benefitTokens.has(t))) {
        for (const p of tb.customer_phrases || []) {
          if (p && typeof p === "string" && p.trim()) {
            phrases.add(p.trim().toLowerCase());
          }
        }
      }
    }
    if (phrases.size === 0) continue;

    const phraseList = Array.from(phrases);
    const matched: string[] = [];
    for (const r of corpus) {
      if (phraseList.some((p) => r.body.includes(p))) matched.push(r.id);
    }
    if (matched.length > 0) benefit_review_matches[b.benefit_name] = matched;
  }

  return NextResponse.json(
    {
      featured: featuredRes.data || [],
      recent: recentRes.data || [],
      total: totalRes.count || 0,
      benefit_review_matches,
    },
    {
      headers: {
        // 60s edge cache + 300s SWR — fresh enough that new reviews
        // surface within a minute, cheap enough that we don't scan the
        // corpus on every visit.
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    },
  );
}
