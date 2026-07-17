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
