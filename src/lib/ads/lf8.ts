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
  // offer / urgency (#5/#6). NB: `free shipping` was removed from the offer/urgency cluster
  // (CEO 2026-07-21) — it's a trust / risk-reversal element (like a money-back guarantee), NOT a
  // deal-chase discount, so it's allowed in cold copy. Kept in lockstep with COLD_OFFER_TOKENS.
  "save", "off", "deal", "today",
];

export function hasAnyLf8(copyLower: string): boolean {
  for (const kw of LF8_KEYWORDS) if (copyLower.includes(kw)) return true;
  return false;
}

/**
 * COLD_OFFER_TOKENS — deal-chase vocabulary that OFTEN signals offer language in a cold caption.
 *
 * ⚠️ ADVISORY ONLY as of CEO 2026-08-17. This list is NOT a gate and MUST NOT be used as one.
 * It is handed to the reasoning layer (Dahlia's author session + Max's copy QC) as a hint of what
 * to look at, and each hit is judged IN CONTEXT.
 *
 * History — why it stopped being a gate. It used to hard-fail any cold caption containing one of
 * these as a whole word, which meant ordinary English tripped it: "takes the edge off", "deal with
 * the 3pm crash", "not something you feel today", "save your energy for the afternoon". The author
 * prompt simultaneously REQUIRES six long-form three-paragraph captions per emit (canonical + five
 * framework variations), so the odds of a clean pass were poor and Dahlia burned her revises on a
 * reason string that never named the offending word. Same class as the 2026-07-17 `"coffee"
 * .includes("off")` bug: word boundaries fixed false SUBSTRINGS but not false MEANINGS. The
 * judgement is semantic, so it belongs to the AI session that exists to make it — not to a literal
 * token match. See `coldOfferLeakMatch` for the two mechanical rails that remain.
 *
 * Under Advantage+ the creative IS the audience selector, so a cold-audience creative that leaks
 * offer/price language is still the #1 DTC creative error — that reasoning is unchanged. What
 * changed is WHO decides whether a given sentence commits it.
 */
export const COLD_OFFER_TOKENS: readonly string[] = [
  "save", "off", "deal", "today", "sale", "discount", "coupon", "promo", "clearance", "bogo",
];

/** A DISCOUNT percent — a percentage adjacent to an offer word ("50% off", "save 40%", "20% discount").
 *  A BARE percentage (`40% more focus`, `95% of drinkers`) is a benefit/social-proof STAT, NOT an
 *  offer — cold copy may cite it (a cold curiosity/problem ad often leads with a stat). The old bare
 *  `\b\d{1,3}%` flagged every stat, which — on top of the "coffee" bug — starved cold copy. */
const DISCOUNT_PERCENT_RE = /(\bsave\b[^.\n]{0,12}\d{1,3}\s*%)|(\d{1,3}\s*%\s*(off|discount|savings?)\b)/i;
/** Bare-currency leak (e.g. "$29", "$5") — a price shown to a cold stranger is a warm/hot move.
 *  Captures the WHOLE price ("$29.99", "$1,200") so the revise reason can quote the literal
 *  offending text rather than a single digit. */
const BARE_CURRENCY_RE_G = /\$\d[\d,.]*/;

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

/** What a cold-offer leak matched, so the caller can tell the author WHICH words to fix rather
 *  than handing back a bare category. `excerpt` is the literal matched text from the caption. */
export interface ColdOfferLeakMatch {
  /** `discount_percent` — a percentage adjacent to an offer word ("50% off", "save 40%").
   *  `bare_price` — a literal price shown to a cold stranger ("$29"). */
  pattern: "discount_percent" | "bare_price";
  excerpt: string;
}

/**
 * coldOfferLeakMatch — the two MECHANICAL cold-audience rails, and nothing else.
 *
 * These two survive as deterministic checks because they are unambiguous: a printed price or a
 * printed discount percentage is deal-chase language in every context, so no reasoning is needed
 * and none should be spent. Everything semantic — whether a sentence is *pitching an offer* — is
 * Max's call in copy QC, informed by COLD_OFFER_TOKENS as a hint list rather than a ban list
 * (CEO 2026-08-17: "this is why there is an AI session, to use reasoning").
 *
 * Returns the FIRST match with the literal offending excerpt, or null when clean. The excerpt is
 * what makes the one sanctioned revise actionable — the pre-2026-08-17 gate returned a bare
 * `cold_offer_leak`, so the author had to guess which of six long captions was at fault.
 *
 * When `allowedOffer` is provided (OUR real brief.offer), its exact headline / disclaimer strings
 * are stripped from the joined scan text BEFORE the rails run — so an offer-for-offer swap that
 * renders our real offer verbatim isn't flagged (see [[../ads/debrand]] `chooseGroundedSubstitute`).
 * A DIFFERENT discount ("50% off") still trips.
 *
 * The temperature check itself lives at the CALLER — this predicate just classifies the copy. The
 * caller fires it only when the row's audience_temperature is 'cold'; warm/hot/null rows pass
 * through untouched. See [[../ads/creative-agent]] insertReadyCreative.
 */
export function coldOfferLeakMatch(
  copy: { headline: string; primaryText: string; description: string },
  allowedOffer?: AllowedOffer | null,
): ColdOfferLeakMatch | null {
  const joinedRaw = `${copy.headline} ${copy.primaryText} ${copy.description}`;
  const joined = stripAllowedOfferPhrases(joinedRaw, allowedOffer);
  const pct = joined.match(DISCOUNT_PERCENT_RE);
  if (pct) return { pattern: "discount_percent", excerpt: pct[0].trim() };
  const price = joined.match(BARE_CURRENCY_RE_G);
  if (price) return { pattern: "bare_price", excerpt: price[0].trim() };
  return null;
}

/** Boolean form of `coldOfferLeakMatch`, kept for the callers that only branch on it. Prefer
 *  `coldOfferLeakMatch` anywhere the reason is surfaced to an author or an operator. */
export function hasColdOfferLeak(
  copy: { headline: string; primaryText: string; description: string },
  allowedOffer?: AllowedOffer | null,
): boolean {
  return coldOfferLeakMatch(copy, allowedOffer) !== null;
}
