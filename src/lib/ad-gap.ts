/**
 * Ad-gap analysis — the Ad Creative Scout's gap-finding layer (docs/brain/specs/ad-creative-scout.md,
 * Phase 1; M2 of docs/brain/goals/acquisition-research-engine.md).
 *
 * The capture half (adlibrary.ts + creative-skeleton.ts) now stores the COMPLETE AdLibrary payload
 * per competitor ad — angle (vision skeleton), format, offer, CTA, copy, spend, longevity. This file
 * is the COMPARISON half: it clusters competitors' winning angles and surfaces the ones we DON'T run
 * as concrete "competitor X (+N brands) runs this angle/offer/format we don't" recommendations, each
 * backed by the supporting ad evidence (advertiser, longevity, spend, destination domain, creative).
 *
 * Deterministic + on-demand (token-overlap clustering, no per-load LLM spend) — same shape as
 * buildPatternMatrix. "Ours" is the active product_ad_angles corpus (the angles we already run);
 * a competitor angle that doesn't overlap that corpus is a gap. Independent-brand repetition +
 * longevity + spend rank the gaps — never a single ad's metrics.
 *
 * North-star: this PROPOSES gaps with evidence; the Growth director approves what becomes an ad
 * iteration. It optimizes a bounded proxy (cross-brand angle recurrence), the role agent owns the
 * objective. See docs/brain/operational-rules.md § North star.
 */
import { createAdminClient } from "@/lib/supabase/admin";

interface CompetitorAdRow {
  advertiser: string | null;
  hook: string | null;
  mechanism_claim: string | null;
  proof: string | null;
  offer: string | null;
  format: string | null;
  call_to_action: string | null;
  days_running: number | null;
  estimated_spend: number | null;
  destination_domain: string | null;
  image_url: string | null;
  seed_kind: string | null;
}

export interface AdEvidence {
  advertiser: string | null;
  angle: string | null;
  format: string | null;
  offer: string | null;
  call_to_action: string | null;
  days_running: number | null;
  estimated_spend: number | null;
  destination_domain: string | null;
  image_url: string | null;
}

export interface AdGapRecommendation {
  /** Always "angle" in Phase 1 — the gap is keyed on the angle; format/offer/CTA enrich it. */
  dimension: "angle";
  /** Canonical label for the competitor angle we don't run. */
  label: string;
  /** The human recommendation surfaced to the Growth director. */
  recommendation: string;
  /** Distinct INDEPENDENT competitor brands running this angle — the primary rank signal. */
  brandCount: number;
  brands: string[];
  /** Longevity + spend supporting "this is a winner for them". */
  maxDaysRunning: number;
  totalEstimatedSpend: number;
  /** What the competitors pair the angle with (the format/offer/CTA facets the spec calls out). */
  formats: string[];
  offers: string[];
  ctas: string[];
  /** Sample ads backing the gap (incl. destination domains for landing-page-scout). */
  evidence: AdEvidence[];
}

export interface AdGapReport {
  /** Analyzed competitor skeletons reasoned over. */
  generatedFrom: number;
  /** Active angles we already run (the "ours" corpus). */
  ourAngleCount: number;
  /** Competitor angle clusters that overlap ours (NOT gaps) — for transparency. */
  coveredAngles: number;
  recommendations: AdGapRecommendation[];
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "you", "our", "that", "this", "from", "are",
  "was", "can", "get", "all", "out", "now", "new", "more", "best", "than", "without",
  "have", "has", "not", "but", "any", "into", "they", "their",
]);

function tokens(s: string | null): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

function shortest(values: string[]): string {
  return values.filter(Boolean).slice().sort((x, y) => x.length - y.length)[0] || "";
}

function topByCount(values: (string | null)[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const s = (v || "").trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, n);
}

interface Cluster {
  tokenSet: Set<string>;
  ads: CompetitorAdRow[];
  brands: Set<string>;
  values: string[];
  maxDays: number;
  totalSpend: number;
}

/** The angle text for an ad: the mechanism/benefit claim, falling back to the hook. */
function angleText(ad: CompetitorAdRow): string | null {
  return ad.mechanism_claim || ad.hook || null;
}

/**
 * Build the ad-gap report for a workspace: competitor winning angles we don't run, ranked by
 * independent-brand recurrence + longevity + spend, each with supporting ad evidence.
 */
export async function buildAdGapReport(
  workspaceId: string,
  opts: { minBrands?: number; minDaysRunning?: number } = {},
): Promise<AdGapReport> {
  const admin = createAdminClient();
  const minBrands = opts.minBrands ?? 1;
  const minDays = opts.minDaysRunning ?? 0;

  // Competitor side: analyzed skeletons that carry an angle + an advertiser.
  const { data: compData } = await admin
    .from("creative_skeletons")
    .select(
      "advertiser, hook, mechanism_claim, proof, offer, format, call_to_action, days_running, estimated_spend, destination_domain, image_url, seed_kind",
    )
    .eq("workspace_id", workspaceId)
    .eq("source", "adlibrary")
    .in("status", ["analyzed", "shortlisted"])
    .not("advertiser", "is", null);
  const compAds = (compData || []) as CompetitorAdRow[];

  // Our side: the active angles we already run (verbatim corpus).
  const { data: oursData } = await admin
    .from("product_ad_angles")
    .select("hook_one_liner, pain_now, desired_outcome, lead_benefit_anchor, meta_primary_text, meta_headline")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  const ours = oursData || [];

  const ourTokens = new Set<string>();
  for (const a of ours) {
    for (const field of [
      a.hook_one_liner,
      a.pain_now,
      a.desired_outcome,
      a.lead_benefit_anchor,
      a.meta_primary_text,
      a.meta_headline,
    ] as (string | null)[]) {
      for (const t of tokens(field)) ourTokens.add(t);
    }
  }

  // Cluster competitor ads by angle (greedy token-overlap, Jaccard ≥ 0.34).
  const clusters: Cluster[] = [];
  let generatedFrom = 0;
  for (const ad of compAds) {
    const text = angleText(ad);
    const ts = tokens(text);
    if (!text || !ts.size || !ad.advertiser) continue;
    if ((ad.days_running ?? 0) < minDays) continue;
    generatedFrom++;

    let best: Cluster | null = null;
    let bestScore = 0;
    for (const cl of clusters) {
      const j = jaccard(ts, cl.tokenSet);
      if (j > bestScore) {
        bestScore = j;
        best = cl;
      }
    }
    if (best && bestScore >= 0.34) {
      best.ads.push(ad);
      best.brands.add(ad.advertiser);
      best.values.push(text);
      best.maxDays = Math.max(best.maxDays, ad.days_running ?? 0);
      best.totalSpend += ad.estimated_spend ?? 0;
      for (const t of ts) best.tokenSet.add(t);
    } else {
      clusters.push({
        tokenSet: new Set(ts),
        ads: [ad],
        brands: new Set([ad.advertiser]),
        values: [text],
        maxDays: ad.days_running ?? 0,
        totalSpend: ad.estimated_spend ?? 0,
      });
    }
  }

  // A cluster is a GAP if our active-angle corpus doesn't overlap it (we don't run this angle).
  const GAP_OVERLAP = 0.12;
  const recommendations: AdGapRecommendation[] = [];
  let coveredAngles = 0;
  for (const cl of clusters) {
    if (cl.brands.size < minBrands) continue;
    const overlap = jaccard(cl.tokenSet, ourTokens);
    if (overlap >= GAP_OVERLAP) {
      coveredAngles++;
      continue;
    }
    const label = shortest(cl.values);
    const brands = [...cl.brands];
    const formats = topByCount(cl.ads.map((a) => a.format), 3);
    const offers = topByCount(cl.ads.map((a) => a.offer), 3);
    const ctas = topByCount(cl.ads.map((a) => a.call_to_action), 3);

    const brandLabel = brands[0] + (brands.length > 1 ? ` +${brands.length - 1} more` : "");
    const offerBit = offers.length ? ` (offer: ${offers[0]})` : "";
    recommendations.push({
      dimension: "angle",
      label,
      recommendation: `${brandLabel} runs the "${label}" angle${offerBit} — we don't. ${cl.brands.size} competitor brand${cl.brands.size > 1 ? "s" : ""}, up to ${cl.maxDays} days running. Test it.`,
      brandCount: cl.brands.size,
      brands,
      maxDaysRunning: cl.maxDays,
      totalEstimatedSpend: Math.round(cl.totalSpend),
      formats,
      offers,
      ctas,
      evidence: cl.ads
        .slice()
        .sort((a, b) => (b.days_running ?? 0) - (a.days_running ?? 0))
        .slice(0, 5)
        .map((a) => ({
          advertiser: a.advertiser,
          angle: angleText(a),
          format: a.format,
          offer: a.offer,
          call_to_action: a.call_to_action,
          days_running: a.days_running,
          estimated_spend: a.estimated_spend,
          destination_domain: a.destination_domain,
          image_url: a.image_url,
        })),
    });
  }

  // Rank: independent-brand recurrence, then longevity, then spend.
  recommendations.sort(
    (a, b) =>
      b.brandCount - a.brandCount ||
      b.maxDaysRunning - a.maxDaysRunning ||
      b.totalEstimatedSpend - a.totalEstimatedSpend,
  );

  return {
    generatedFrom,
    ourAngleCount: ours.length,
    coveredAngles,
    recommendations,
  };
}
