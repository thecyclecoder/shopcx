/**
 * lf8 — the single source of truth for the Life-Force-8 keyword list + membership check, shared by:
 *   - [[../ads-supervisor]] live-ad QA (`live_ad_lf8_thin` finding — detects a live creative whose
 *     headline / primary text carries none of these terms)
 *   - [[./creative-brief]] `buildMetaCopy` (biases the generated caption toward an LF8-adjacent
 *     benefit so the ads-supervisor gate is satisfied by construction, not repair)
 *
 * Kept in ONE place so the gate and the generator can't drift — a divergence would let Dahlia
 * publish copy the supervisor immediately re-flags as thin.
 *
 * Life-Force-8 (Dr. Whitman): one-token lowercase forms so a substring scan hits without a
 * natural-language pass. Broadly-appealing terms only; the point is to catch a live ad whose copy
 * has NONE of these (i.e. reads like a feature dump rather than a benefit-driven acquisition ad).
 */
export const LF8_KEYWORDS: readonly string[] = [
  // 1. survival / enjoyment of life / life extension
  "energy", "sleep", "health", "life", "years", "longevity", "vitality", "focus", "clarity", "wake",
  // 2. enjoyment of food/drink
  "delicious", "taste", "flavor", "coffee", "morning", "drink",
  // 3. freedom from fear/pain/danger
  "crash", "safe", "protect", "calm", "relief", "stress", "anxiety", "worry",
  // 4. sexual companionship — largely off-brand for the coffee vertical; kept out.
  // 5. comfortable living
  "easy", "smooth", "effortless", "comfortable",
  // 6. to be superior / win
  "boost", "beat", "power", "better", "unlock", "peak", "sharper",
  // 7. care and protection of loved ones
  "family", "kids", "loved", "share",
  // 8. social approval
  "trust", "proven", "loved by", "customers", "reviews",
  // weight-loss / body-transformation (#1/#5/#6/#8) — four folded live-ad-lf8 fix-specs
  // (adsets 120252355815780184 / 120252360719940184 / 120252360719970184 / 120252363256660184)
  // tripped on this cluster's absence; e.g. 'i lost 40+ pounds! appetite suppression/craving control'.
  "weight", "pounds", "lbs", "lost", "slim", "lean", "shed", "appetite", "craving", "transformation", "fit",
  // beauty / appearance (#1/#8)
  "skin", "hair", "nails", "glow", "collagen", "youthful", "radiant",
  // immunity / digestion (#1/#3)
  "immune", "immunity", "gut", "digestion", "bloat", "gut health",
  // mood / wellness (#1/#3)
  "mood", "happy", "balance", "wellness", "thrive",
  // offer / urgency (#5/#6)
  "save", "off", "free shipping", "deal", "today",
];

export function hasAnyLf8(copyLower: string): boolean {
  for (const kw of LF8_KEYWORDS) if (copyLower.includes(kw)) return true;
  return false;
}

/**
 * COLD_OFFER_TOKENS — the offer / urgency cluster that must NEVER appear in a cold-audience
 * creative's caption (docs/brain/specs/dahlia-audience-temperature-marking-and-cold-offer-gate.md
 * Phase 2). Deliberately the SAME cluster already SSOT'd in LF8_KEYWORDS (offer/urgency, lines
 * 41-42) — a divergent list would let a hallucinated cold caption ship with an LF8-flagged token
 * the ads-supervisor gate would still see, defeating the whole point.
 *
 * Under Advantage+ the creative IS the audience selector, so a cold-audience creative that leaks
 * offer/price language is the #1 DTC creative error: it retargets warm-shopper language at a
 * cold viewer who's never heard of the brand.
 */
export const COLD_OFFER_TOKENS: readonly string[] = [
  "save", "off", "free shipping", "deal", "today",
];

/** Bare-percent leak (e.g. "20%", "43%"). Word-boundary + 1-3 digits + '%'. */
const BARE_PERCENT_RE = /\b\d{1,3}%/;
/** Bare-currency leak (e.g. "$29", "$5"). '$' followed by any digit. */
const BARE_CURRENCY_RE = /\$\d/;

/**
 * hasColdOfferLeak — DETERMINISTIC gate the persister chokepoint (insertReadyCreative) runs
 * before writing a status='ready' row. Given the three Meta copy fields, return true iff:
 *   (a) any COLD_OFFER_TOKENS substring hits (case-insensitive), OR
 *   (b) a bare-percent pattern hits (BARE_PERCENT_RE), OR
 *   (c) a bare-currency pattern hits (BARE_CURRENCY_RE).
 *
 * The temperature check itself lives at the CALLER — this predicate just classifies the copy.
 * The caller fires it only when the row's audience_temperature is 'cold'; warm/hot/null rows
 * pass through untouched. See [[../ads/creative-agent]] insertReadyCreative.
 */
export function hasColdOfferLeak(copy: { headline: string; primaryText: string; description: string }): boolean {
  const joined = `${copy.headline} ${copy.primaryText} ${copy.description}`.toLowerCase();
  for (const t of COLD_OFFER_TOKENS) if (joined.includes(t)) return true;
  if (BARE_PERCENT_RE.test(joined)) return true;
  if (BARE_CURRENCY_RE.test(joined)) return true;
  return false;
}
