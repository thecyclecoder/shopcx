/**
 * debrand — strip a competitor's brand + product tokens out of a debranded slot so Dahlia's
 * author session can reuse the WORDS the winner's 45+ paid days already proved without echoing
 * the rival's brand marks. Pure + testable + null-safe; the M2
 * dahlia-preserve-competitor-copy-dna-debranded spec's Phase 1 helper.
 *
 * Rules (pinned by src/lib/ads/debrand.test.ts):
 *   (a) null-safe — empty text or null competitorAdvertiser returns the input unchanged.
 *   (b) tokenize competitorAdvertiser on whitespace, keep tokens with ≥3 chars, drop a small
 *       hardcoded product-name allowlist ("coffee", "tea", "mud", "drink", "creamer", "matcha")
 *       so a benign token in the advertiser name never over-strips the caption. Each remaining
 *       token is deleted from `text` case-insensitively as a whole word.
 *   (c) also strips a possessive suffix ("'s" / "’s") on the same tokens.
 *   (d) collapses runs of whitespace + trims leading/trailing whitespace + orphan punctuation.
 *
 * NOTE: the WORD-BOUNDARY match uses a manual left/right non-word-adjacency check instead of
 * `\b…\b` — a competitor token like "MUD/WTR" carries a `/` (non-word char) so `\b` on the
 * inside boundary fails; we require the char BEFORE the match to be nothing / start / non-word
 * and the char AFTER to be nothing / end / non-word / apostrophe (so `MUD/WTR's` also matches).
 *
 * ── OFFER SWAP (swap-competitor-offer-slot-for-our-grounded-proof-benefit-or-feature-in-debrand
 * Phase 1) ────────────────────────────────────────────────────────────────────────────────────
 * A competitor's offer slot (free tote / free gift / bonus item / discount) is an OFFER we do
 * not actually run — carrying it through the debrand into Dahlia's imitation rubric fails every
 * downstream gate (firewall claim-miss on the ungrounded freebie, cold-offer-leak on the
 * discount to a cold audience — both correctly refusing an offer we don't run). The fix is to
 * SWAP the offer slot for one of OUR grounded selling points from the brief (a proofStack proof
 * point, a supportingBenefit / lead benefit, or a derived product feature like ingredient count
 * / format) so the WINNING STRUCTURE survives but the promise becomes grounded.
 *   • `isCompetitorOffer(text)` — detector for free-gift / free-tote / bonus item / giveaway /
 *     discount phrasing.
 *   • `stripCompetitorOffer(text)` — remove those phrases from a hook so an offer surviving in
 *     the hook doesn't leak either (structural words are preserved).
 *   • `chooseGroundedSubstitute(brief)` — pick the best grounded selling point from the brief:
 *     brief.offer (OUR real offer — an offer-for-offer swap) → proofStack proof point →
 *     supportingBenefit → leadProof text → productFeatures fallback.
 *
 * ── OFFER-FOR-OFFER SWAP (debrand-offer-swap-prefers-our-real-offer-free-shipping-subscribe-
 * and-save-offer-for-offer Phase 1) ─────────────────────────────────────────────────────────
 * When the competitor's slot is an OFFER we don't run (free tote / bonus item / discount) AND
 * we have a REAL brief.offer of our own (e.g. `Up to 34% off + free shipping` with disclaimer
 * `with 3+ units on Subscribe & Save`), PREFER our real offer as the swap-in — an offer-for-
 * offer swap keeps the ad's persuasive OFFER POSITION intact without leading on coupons. Only
 * when brief.offer is null does the chooser fall back to the proof / benefit / feature chain.
 * The cold-offer gate ([[./lf8]] `hasColdOfferLeak`) accepts an `allowedOffer` allowlist so
 * OUR real offer (which naturally carries `free shipping` / `save` LF8 tokens) is NOT flagged
 * as a cold-audience leak — brief.offer is the only allowed source of an offer phrase.
 */

const PRODUCT_NAME_ALLOWLIST: ReadonlySet<string> = new Set([
  "coffee",
  "tea",
  "mud",
  "drink",
  "creamer",
  "matcha",
]);

/** Escape a token for use inside a RegExp — `/`, `.`, `\`, and every other regex-special char. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** True when the char at index `i` is a "word-ish" boundary neighbor (letter / digit / `_`) —
 *  the token match must NOT be surrounded by these on either side. Position outside string is a
 *  boundary (treated as non-word). */
function isWordChar(s: string, i: number): boolean {
  if (i < 0 || i >= s.length) return false;
  const c = s.charCodeAt(i);
  // 0-9, A-Z, a-z, _
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95
  );
}

/**
 * Remove every whole-word occurrence of `token` (case-insensitive) from `text`, plus a trailing
 * possessive `'s` / `’s` if one is attached. Runs of whitespace introduced by the deletion are
 * collapsed to a single space by the caller.
 */
function stripToken(text: string, token: string): string {
  const escaped = escapeRegExp(token);
  // Match the token followed by an optional possessive suffix (straight or curly apostrophe).
  const re = new RegExp(`${escaped}(?:['’]s)?`, "gi");
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    // Word-boundary check: the char before the match and the char after must not be word chars.
    if (isWordChar(text, start - 1) || isWordChar(text, end)) {
      // Not a whole-word hit — skip this match, keep scanning past it.
      re.lastIndex = end;
      continue;
    }
    out += text.slice(cursor, start);
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Strip a competitor's brand + product tokens out of `text` so it's safe to reuse as Dahlia's
 * authoring material. Deterministic + pure + null-safe. See the file header for full rules.
 *
 * @param text                 The debranded-slot text (a competitor's hook / framework /
 *                             mechanism_claim / proof / offer). Returned unchanged when empty.
 * @param competitorAdvertiser The competitor's brand name (e.g. "MUD/WTR", "Ryze"). Null-safe
 *                             — a null / empty value returns `text` unchanged.
 * @param ourBrand             Reserved for future disambiguation (e.g. never strip our own
 *                             brand's tokens even if a competitor collides). Currently unused
 *                             — kept in the signature so callers can wire it now.
 */
export function debrandForOurBrand(
  text: string,
  competitorAdvertiser: string | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ourBrand: string,
): string {
  if (!text) return text;
  if (!competitorAdvertiser) return text;
  const tokens = competitorAdvertiser
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !PRODUCT_NAME_ALLOWLIST.has(t.toLowerCase()));
  if (tokens.length === 0) return text;
  let out = text;
  for (const t of tokens) out = stripToken(out, t);
  // Collapse whitespace and trim; also trim orphan leading/trailing punctuation left behind.
  out = out.replace(/\s{2,}/g, " ").replace(/^[\s,;:.|\-·—–+&]+|[\s,;:.|\-·—–+&]+$/g, "").trim();
  return out;
}

// ── Offer swap (Phase 1) ────────────────────────────────────────────────────
// A competitor's offer slot (free tote / free gift / bonus item / giveaway / discount) is an
// offer we do not run. Detect + swap upstream so it never rides the debrand into Dahlia's
// imitation rubric. See file header § OFFER SWAP.

// Freebie/bonus phrasing patterns. The `free (thing)` list is deliberately narrow — a proven
// competitor freebie vocabulary (tote, mug, gift, sample, bottle, scoop, shaker, kit) — because
// a broad `\bfree\s+\w+\b` catches sentence tails like "free of" / "free from". Discount
// patterns mirror sanitizeCompetitorHook (percent-off / $-off / free-shipping / BOGO / X for $Y)
// so the two helpers agree on what a competitor OFFER is.
const OFFER_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bfree\s+(?:tote|bag|gift|mug|shaker|bottle|scoop|frother|book|guide|pack|kit|set|sample|samples|item|bonus)\b/gi,
  /\b(?:bonus|complimentary)\s+(?:gift|item|pack|bag|tote|mug|scoop|shaker)\b/gi,
  /\bgiveaway\b/gi,
  /\b(?:up to\s+)?\d{1,3}\s*%\s*(?:off|discount|savings?)\b/gi,
  /\bsave\s+(?:up to\s+)?(?:\$\d[\d.,]*|\d{1,3}\s*%)(?=\s|$|[^\w%])/gi,
  /\b\$\d[\d.,]*\s*off\b/gi,
  /\bfree\s+shipping\b/gi,
  /\b(?:bogo|buy\s+one\s+get\s+one(?:\s+free)?)\b/gi,
  /\b\d+\s+for\s+\$?\d[\d.,]*\b/gi,
  /\b\d+\s+for\s+the\s+price\s+of\s+\d+\b/gi,
];

/**
 * True when `text` carries a competitor-offer token (free gift / free tote / bonus item /
 * giveaway / a percent-off, $-off, free-shipping, BOGO or "X for $Y" discount). Null-safe.
 * Used to decide whether to SWAP the competitor's offer slot (or an offer that survived in the
 * hook) for a grounded selling point from OUR brief.
 */
export function isCompetitorOffer(text: string | null | undefined): boolean {
  if (!text) return false;
  return OFFER_TOKEN_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/**
 * Strip every competitor-offer phrase (see `isCompetitorOffer`) out of `text`, collapse
 * orphan separators + whitespace, and trim orphan leading/trailing punctuation. Preserves the
 * structural words that carry the WINNING STRUCTURE (e.g. "Free tote badge with product held
 * up outdoors" → "with product held up outdoors"). Null-safe — an empty string is returned
 * unchanged.
 */
export function stripCompetitorOffer(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of OFFER_TOKEN_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, " ");
  }
  // A stripped phrase often leaves an orphan separator between two spaces ("Coffee  —  today")
  // and dangling punctuation at either end. Collapse both so what remains reads naturally.
  out = out.replace(/\s+[—–\-|·+&]\s+/g, " ");
  out = out.replace(/^[\s,;:.|\-·—–+&]+|[\s,;:.|\-·—–+&]+$/g, "");
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

/**
 * Minimal shape `chooseGroundedSubstitute` reads from the brief. Kept local so `debrand.ts`
 * has no import cycle with `creative-brief.ts`; a real `CreativeBrief` is structurally
 * assignable (all fields optional / nullable — a fake brief in a test is trivial to build).
 */
export interface GroundedSubstituteSource {
  /** OUR real store offer (e.g. `headline: "Up to 34% off + free shipping"`, `disclaimer:
   *  "with 3+ units on Subscribe & Save"`). PREFERRED as the offer-slot substitute so the
   *  swap is offer-for-offer — the ad's persuasive OFFER POSITION survives without leading
   *  on a coupon. Missing / null → the chooser falls back to proof / benefit / feature. */
  offer?: { headline?: string | null; disclaimer?: string | null } | null;
  proofStack?: string[] | null;
  supportingBenefits?: string[] | null;
  leadProof?: { text: string | null } | null;
  /** Derived product features (e.g. "15 superfoods per tab", "fizz and drink" format). The
   *  brief builder populates this from `pi.ingredients.length` + product title when available;
   *  a substitute rarely falls this far since proofStack usually carries a real proof point. */
  productFeatures?: string[] | null;
}

/** Render brief.offer as an offer-slot string — the ad-ready headline joined with the disclaimer
 *  in parens when present. Returns null when the offer has no usable headline. */
function renderBriefOffer(offer: GroundedSubstituteSource["offer"]): string | null {
  if (!offer) return null;
  const headline = typeof offer.headline === "string" ? offer.headline.trim() : "";
  if (!headline) return null;
  const disclaimer = typeof offer.disclaimer === "string" ? offer.disclaimer.trim() : "";
  return disclaimer ? `${headline} (${disclaimer})` : headline;
}

/**
 * Pick the best substitute for a competitor offer we do not run. Priority (per the CEO's
 * offer-for-offer fix note):
 *   (1) brief.offer — OUR real store offer (e.g. free shipping with Subscribe & Save). Keeps
 *       the ad's OFFER POSITION intact — an offer-for-offer swap. Only when brief.offer is
 *       null / empty do we fall back to a grounded proof/benefit/feature.
 *   (2) proofStack proof point (verified proof — 700K+ customers, awards, certs)
 *   (3) supportingBenefits (a retention benefit)
 *   (4) leadProof.text
 *   (5) productFeatures (derived: ingredient count, format)
 * Returns null when the brief carries no substitute at all — the caller then nulls the
 * competitorDna.offer slot (Dahlia's session already accepts a null offer for cold audiences).
 */
export function chooseGroundedSubstitute(brief: GroundedSubstituteSource): string | null {
  const ourOffer = renderBriefOffer(brief.offer ?? null);
  if (ourOffer) return ourOffer;
  const proof = brief.proofStack?.find((p) => typeof p === "string" && p.trim().length > 0);
  if (proof) return proof.trim();
  const support = brief.supportingBenefits?.find((b) => typeof b === "string" && b.trim().length > 0);
  if (support) return support.trim();
  const leadText = brief.leadProof?.text;
  if (typeof leadText === "string" && leadText.trim().length > 0) return leadText.trim();
  const feat = brief.productFeatures?.find((f) => typeof f === "string" && f.trim().length > 0);
  if (feat) return feat.trim();
  return null;
}
