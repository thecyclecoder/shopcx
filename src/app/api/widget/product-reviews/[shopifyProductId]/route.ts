import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Categorised product reviews for the storefront review widget.
 *
 * Reads the benefit buckets that product intelligence already derived
 * (product_review_analysis.top_benefits — each carries the review_ids it was drawn
 * from) and hydrates them with the real rows from product_reviews. Nothing here
 * invents a category or a quote: a product with no analysis row returns no
 * categories, and the widget renders nothing rather than filling the gap.
 *
 * Keyed by SHOPIFY product id so a Liquid template can call it with `product.id`
 * and stay generic across products.
 *
 * ?merge=<id,id> folds sibling products' analyses into the same buckets — the K-Cups
 * and the ground-coffee listing are the same formula, so their reviews describe one
 * product even though the catalogue splits them. The pairing lives in the template's
 * render call, not here, so this route stays generic.
 */

// Short tab labels from the analysis's own benefit sentences. Keyword-driven rather
// than a per-product table, so a newly analysed product needs no code change.
const LABELS: Array<[RegExp, string]> = [
  [/craving|appetite|hunger|snack/i, "Cravings"],
  [/weight|scale|pounds|lbs/i,       "Weight loss"],
  [/energy|jitter|crash/i,           "Energy"],
  [/focus|clarity|brain|mental/i,    "Focus"],
  [/stomach|digest|bloat|gut|reflux/i, "Digestion"],
  [/aging|younger|skin|wrinkl/i,     "Aging"],
  [/sleep|rest/i,                    "Sleep"],
  [/taste|flavor|flavour|mocha/i,    "Taste"],
  [/stress|cortisol|calm|mood/i,     "Mood"],
  [/ingredient|superfood|mushroom|natural/i, "Ingredients"],
  [/immun/i,                         "Immunity"],
];
// Analyses disagree on how they express frequency: some write "very high", others
// write a raw mention count. Both are normalised to one 0-4 score so buckets from
// different products can be ordered against each other.
const FREQ_WORDS: Record<string, number> = { "very high": 4, high: 3, moderate: 2, low: 1 };

function freqScore(frequency: unknown, maxCount: number): number {
  if (typeof frequency === "number" && Number.isFinite(frequency)) {
    return maxCount > 0 ? (frequency / maxCount) * 4 : 0;
  }
  const w = String(frequency ?? "").toLowerCase().trim();
  return FREQ_WORDS[w] ?? 0;
}

function labelFor(benefit: string): string {
  for (const [re, label] of LABELS) if (re.test(benefit)) return label;
  return benefit.split(/\s+/).slice(0, 2).join(" ");
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  // storefront-public data only: published reviews already visible on the PDP
  "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ shopifyProductId: string }> },
) {
  const { shopifyProductId } = await params;
  const limitPer = Math.min(Math.max(Number(req.nextUrl.searchParams.get("per") ?? 3), 1), 8);
  const mergeIds = (req.nextUrl.searchParams.get("merge") ?? "")
    .split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4);
  const admin = createAdminClient();

  const { data: products } = await admin
    .from("products")
    .select("id, title, shopify_product_id")
    .in("shopify_product_id", [String(shopifyProductId), ...mergeIds]);

  const primary = (products ?? []).find((p) => p.shopify_product_id === String(shopifyProductId));
  if (!primary) {
    return NextResponse.json({ categories: [] }, { headers: CORS });
  }

  const { data: analyses } = await admin
    .from("product_review_analysis")
    .select("product_id, top_benefits, reviews_analyzed_count")
    .in("product_id", (products ?? []).map((p) => p.id));

  type Bucket = { benefit: string; frequency?: string | number; review_ids?: string[] };
  const buckets: Bucket[] = (analyses ?? []).flatMap((a) => (a.top_benefits as Bucket[] | null) ?? []);
  if (!buckets.length) {
    return NextResponse.json({ product: primary.title, categories: [] }, { headers: CORS });
  }

  const ids = [...new Set(buckets.flatMap((b) => b.review_ids ?? []))];
  const { data: reviews } = await admin
    .from("product_reviews")
    .select("id, reviewer_name, rating, body, smart_quote, verified_purchase")
    .in("id", ids);
  const byId = new Map((reviews ?? []).map((r) => [r.id, r]));

  // Merge across products by LABEL: two analyses word the same shelf differently
  // ("Curbs appetite and cravings" vs "Suppresses hunger") but a shopper reads one tab.
  const maxCount = Math.max(
    0,
    ...buckets.map((b) => (typeof b.frequency === "number" ? b.frequency : 0)),
  );
  const merged = new Map<
    string,
    { benefit: string; frequency: string | number | null; score: number; ids: Set<string> }
  >();
  for (const b of buckets) {
    const label = labelFor(b.benefit);
    const cur = merged.get(label);
    if (!cur) {
      merged.set(label, {
        benefit: b.benefit,
        frequency: b.frequency ?? null,
        score: freqScore(b.frequency, maxCount),
        ids: new Set(b.review_ids ?? []),
      });
      continue;
    }
    for (const id of b.review_ids ?? []) cur.ids.add(id);
    const score = freqScore(b.frequency, maxCount);
    if (score > cur.score) {
      cur.score = score;
      cur.frequency = b.frequency ?? cur.frequency;
      cur.benefit = b.benefit;
    }
  }

  const categories = [...merged.entries()]
    .sort((x, y) => y[1].score - x[1].score || y[1].ids.size - x[1].ids.size)
    .map(([label, c]) => ({
      label,
      benefit: c.benefit,
      frequency: typeof c.frequency === "string" ? c.frequency : null,
      reviews: [...c.ids]
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r?.body))
        // a verified reviewer is the stronger proof, so lead with those
        .sort((x, y) => Number(Boolean(y.verified_purchase)) - Number(Boolean(x.verified_purchase)))
        .slice(0, limitPer)
        .map((r) => ({
          name: r.reviewer_name ?? "Verified customer",
          rating: r.rating ?? 5,
          quote: r.smart_quote ?? null,
          body: r.body,
          verified: Boolean(r.verified_purchase),
        })),
    }))
    .filter((c) => c.reviews.length > 0);

  const analyzedCount = (analyses ?? []).reduce((n, a) => n + (a.reviews_analyzed_count ?? 0), 0);

  return NextResponse.json(
    { product: primary.title, analyzedCount, categories },
    { headers: CORS },
  );
}
