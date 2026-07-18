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
  "save", "off", "free shipping", "deal", "today", "sale", "discount", "coupon", "promo", "clearance", "bogo",
];

/** Each cold-offer token, WORD-BOUNDARY anchored + case-insensitive. Substring matching was a real
 *  defect: `"coffee".includes("off")` is TRUE, so EVERY cold coffee creative tripped the gate on the
 *  word "coffee" — a coffee product literally could not author cold copy (2026-07-17 Amazing Coffee
 *  test). `\b` fixes it: `\boff\b` matches "50% off" but not the "off" inside "coffee" (nor "deal" in
 *  "ideal", "save" in "unsaved", "today" in "todays"). */
const COLD_OFFER_TOKEN_RES: readonly RegExp[] = COLD_OFFER_TOKENS.map(
  (t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
);
/** A DISCOUNT percent — a percentage adjacent to an offer word ("50% off", "save 40%", "20% discount").
 *  A BARE percentage (`40% more focus`, `95% of drinkers`) is a benefit/social-proof STAT, NOT an
 *  offer — cold copy may cite it (a cold curiosity/problem ad often leads with a stat). The old bare
 *  `\b\d{1,3}%` flagged every stat, which — on top of the "coffee" bug — starved cold copy. */
const DISCOUNT_PERCENT_RE = /(\bsave\b[^.\n]{0,12}\d{1,3}\s*%)|(\d{1,3}\s*%\s*(off|discount|savings?)\b)/i;
/** Bare-currency leak (e.g. "$29", "$5") — a price shown to a cold stranger is a warm/hot move. */
const BARE_CURRENCY_RE = /\$\d/;

/** debrand-offer-swap-prefers-our-real-offer-free-shipping-subscribe-and-save-offer-for-offer
 *  Phase 1 — OUR real store offer allowlist. When a caller passes `brief.offer`, the exact
 *  headline / disclaimer strings are stripped from the joined scan text BEFORE the leak
 *  predicate runs, so an offer-for-offer swap that renders OUR real offer verbatim (e.g.
 *  `Up to 34% off + free shipping` with disclaimer `with 3+ units on Subscribe & Save`) is
 *  NOT flagged as a cold-audience leak. A different discount (`50% off today`) still trips
 *  the gate because only the EXACT allowed phrases are removed. */
export interface AllowedOffer {
  headline?: string | null;
  disclaimer?: string | null;
}

function escapeRegExpString(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return the joined scan text with each allowed-offer phrase (headline / disclaimer)
 *  removed (case-insensitive, whole-string). Only non-empty, trimmed phrases participate. */
function stripAllowedOfferPhrases(joined: string, allowed: AllowedOffer | null | undefined): string {
  if (!allowed) return joined;
  const phrases: string[] = [];
  if (typeof allowed.headline === "string" && allowed.headline.trim()) phrases.push(allowed.headline.trim());
  if (typeof allowed.disclaimer === "string" && allowed.disclaimer.trim()) phrases.push(allowed.disclaimer.trim());
  if (phrases.length === 0) return joined;
  let out = joined;
  for (const p of phrases) {
    out = out.replace(new RegExp(escapeRegExpString(p), "gi"), " ");
  }
  return out;
}

/**
 * hasColdOfferLeak — DETERMINISTIC gate the persister chokepoint (insertReadyCreative) runs
 * before writing a status='ready' row. Given the three Meta copy fields, return true iff:
 *   (a) any COLD_OFFER_TOKENS hits as a WHOLE WORD (case-insensitive), OR
 *   (b) a DISCOUNT-percent pattern hits (a % adjacent to an offer word — NOT a bare benefit stat), OR
 *   (c) a bare-currency pattern hits (a price shown to a cold viewer).
 *
 * When `allowedOffer` is provided (OUR real brief.offer), its exact headline / disclaimer
 * strings are stripped from the joined scan text BEFORE the predicate runs — so an offer-for-
 * offer swap that renders our real offer verbatim isn't flagged (see [[../ads/debrand]]
 * `chooseGroundedSubstitute`). A DIFFERENT discount ("50% off today") still trips the gate.
 *
 * The temperature check itself lives at the CALLER — this predicate just classifies the copy.
 * The caller fires it only when the row's audience_temperature is 'cold'; warm/hot/null rows
 * pass through untouched. See [[../ads/creative-agent]] insertReadyCreative.
 */
export function hasColdOfferLeak(
  copy: { headline: string; primaryText: string; description: string },
  allowedOffer?: AllowedOffer | null,
): boolean {
  const joinedRaw = `${copy.headline} ${copy.primaryText} ${copy.description}`;
  const joined = stripAllowedOfferPhrases(joinedRaw, allowedOffer);
  for (const re of COLD_OFFER_TOKEN_RES) if (re.test(joined)) return true;
  if (DISCOUNT_PERCENT_RE.test(joined)) return true;
  if (BARE_CURRENCY_RE.test(joined)) return true;
  return false;
}
