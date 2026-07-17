/**
 * copy-validator — the single source of truth for the six deterministic safety rails Dahlia's
 * author box-session and Max's independent copy-QC both check before a Meta caption ships. This
 * module is pure, side-effect-free, and typed: given a candidate copy triple + the brief context,
 * it returns `{pass, checks[]}` where each check reports one rail's verdict + a short reason and
 * (when relevant) an evidence substring.
 *
 * Rolls up rails already SSOT'd elsewhere (LF8 keyword membership, META Ads caption caps, the
 * cold-audience offer gate) plus the three that were previously reimplemented on call sites
 * (MSRP guard, competitor-brand leak scan, single-promise counter). Kept in ONE place so the
 * author's self-check and the QC's pre-check cannot drift — a divergence would let Dahlia
 * publish copy Max immediately re-flags as unsafe, or (worse) let a safety miss slip past both.
 *
 * Consumers wire it in Phase 2:
 *   - Dahlia's stockProduct author-mode branch runs it after parsing her verdict, treats a
 *     pass:false as a copy-only revise trigger.
 *   - Max's runQaCreativeCopyViaBoxSession pre-computes it and hands the {pass, checks[]} to Max
 *     as TRUSTED CONTEXT so he can cite the same rail names in his hard-gates output.
 *
 * Boolean rails only — no rubric — so it cannot Goodhart.
 */
import { hasAnyLf8, hasColdOfferLeak } from "./lf8";
import { META_CAPS } from "../ad-tool-config";
import type { CreativeBrief } from "./creative-brief";

export type ValidatorCopy = { headline: string; primaryText: string; description: string };
export type AudienceTemperature = "cold" | "warm" | "hot" | null;

export type ValidatorRail =
  | "lf8"
  | "meta_caps"
  | "no_msrp"
  | "no_competitor_leak"
  | "cold_offer_gate"
  | "single_promise";

export interface ValidatorCheck {
  rail: ValidatorRail;
  pass: boolean;
  reason?: string;
  evidence?: string;
}

export interface ValidatorContext {
  audience_temperature: AudienceTemperature;
  competitorAdvertisers: string[];
  ourBrand: string;
}

export interface ValidatorResult {
  pass: boolean;
  checks: ValidatorCheck[];
}

/**
 * Kept in lockstep with src/lib/ads/debrand.ts PRODUCT_NAME_ALLOWLIST — a divergence would let
 * the validator flag a "coffee" mention Dahlia's debrand pass would happily strip as a generic
 * product noun. Debrand's list is unexported so we mirror it here with the shared invariant.
 */
const PRODUCT_NAME_ALLOWLIST: ReadonlySet<string> = new Set([
  "coffee",
  "tea",
  "mud",
  "drink",
  "creamer",
  "matcha",
]);

/**
 * Bare-currency pattern: `$29`, `$5`, `$1499` — but NOT `$29-something` (strikethrough writer's
 * markdown) or `$29.99` written as `$2999` (unlikely). The spec's regex `/\$\d+(?![-\d])/g`
 * requires the char after the digits is neither a dash (marks a strikethrough range) nor
 * another digit (partial-price artifact).
 */
const BARE_CURRENCY_RE = /\$\d+(?![-\d])/g;

/** Markdown strikethrough delimiter — `~~$29~~` marks a struck-through original price. */
const STRIKETHROUGH_RE = /~~/;

/**
 * Per-unit phrases that make a bare price permissible ("$1 per serving", "$3 per cup"). Any of
 * these tokens in the same field suppresses the MSRP flag: the price is anchored to a unit, so
 * it reads as value framing rather than raw MSRP.
 */
const PER_UNIT_RE = /\bper\s+(serving|cup|pouch|sachet|scoop|day|week|month)\b/i;

/**
 * Promise-shaped substring list — deterministic; each match is one "unique benefit claim". The
 * validator asserts headline+primaryText together carry AT MOST ONE unique promise, per the M2
 * spec's single-promise rail. Two distinct matches (e.g. "lose 40 lbs" + "boost energy") means
 * the copy is stacking benefits, which historically tanks CTR under Advantage+.
 *
 * Kept intentionally small — the point is to catch obvious multi-claim stacks, not to enumerate
 * every benefit shape. False negatives are fine; false positives on a single-claim caption are
 * not.
 */
const PROMISE_PATTERNS: ReadonlyArray<{ slug: string; re: RegExp }> = [
  { slug: "lose_lbs", re: /\blose\s+\d+\+?\s*(?:lbs|pounds)\b/gi },
  { slug: "boosts_x", re: /\bboost(?:s|ed|ing)?\s+[a-z][a-z\-]{2,}/gi },
  { slug: "more_x", re: /\bmore\s+[a-z][a-z\-]{2,}/gi },
  { slug: "fixes_x", re: /\bfix(?:es|ed|ing)?\s+[a-z][a-z\-]{2,}/gi },
];

/** Word-char probe — matches JS `\w` (0-9, A-Z, a-z, `_`). Position outside the string is a
 *  boundary (non-word). Used for the same manual left/right boundary check debrand.ts uses so a
 *  competitor token containing `/` (e.g. `MUD/WTR`) still matches on both sides. */
function isWordChar(s: string, i: number): boolean {
  if (i < 0 || i >= s.length) return false;
  const c = s.charCodeAt(i);
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * True iff `token` appears in `text` (case-insensitive) with non-word characters (or the string
 * boundary) on both sides — the same rule debrandForOurBrand uses so `MUD/WTR` matches inside
 * a caption despite the `/` breaking `\b` on the inner boundary.
 */
function matchesAsWholeWord(text: string, token: string): { hit: boolean; evidence?: string } {
  const escaped = escapeRegExp(token);
  const re = new RegExp(escaped, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isWordChar(text, start - 1) && !isWordChar(text, end)) {
      return { hit: true, evidence: text.slice(start, end) };
    }
    re.lastIndex = end;
  }
  return { hit: false };
}

/**
 * Tokenize a competitor advertiser string on whitespace, keep tokens ≥3 chars, drop the
 * product-name allowlist — same rule debrandForOurBrand uses when it strips these tokens out
 * of a competitor's copy.
 */
function competitorTokensFor(advertiser: string): string[] {
  return advertiser
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !PRODUCT_NAME_ALLOWLIST.has(t.toLowerCase()));
}

function checkLf8(copy: ValidatorCopy): ValidatorCheck {
  const scan = `${copy.headline} ${copy.primaryText}`.toLowerCase();
  if (hasAnyLf8(scan)) return { rail: "lf8", pass: true };
  return {
    rail: "lf8",
    pass: false,
    reason: "headline + primary text carry no LF8 keyword — reads as a feature dump, not a benefit",
  };
}

function checkMetaCaps(copy: ValidatorCopy): ValidatorCheck {
  if (copy.headline.length > META_CAPS.headline) {
    return {
      rail: "meta_caps",
      pass: false,
      reason: `headline ${copy.headline.length} > META_CAPS.headline ${META_CAPS.headline}`,
      evidence: copy.headline,
    };
  }
  if (copy.primaryText.length > META_CAPS.primary_text) {
    return {
      rail: "meta_caps",
      pass: false,
      reason: `primary text ${copy.primaryText.length} > META_CAPS.primary_text ${META_CAPS.primary_text}`,
    };
  }
  if (copy.description.length > META_CAPS.description) {
    return {
      rail: "meta_caps",
      pass: false,
      reason: `description ${copy.description.length} > META_CAPS.description ${META_CAPS.description}`,
      evidence: copy.description,
    };
  }
  return { rail: "meta_caps", pass: true };
}

function checkNoMsrp(copy: ValidatorCopy): ValidatorCheck {
  const fields: Array<{ name: string; value: string }> = [
    { name: "headline", value: copy.headline },
    { name: "primaryText", value: copy.primaryText },
    { name: "description", value: copy.description },
  ];
  for (const f of fields) {
    const matches = f.value.match(BARE_CURRENCY_RE);
    if (!matches || matches.length === 0) continue;
    if (STRIKETHROUGH_RE.test(f.value)) continue;
    if (PER_UNIT_RE.test(f.value)) continue;
    return {
      rail: "no_msrp",
      pass: false,
      reason: `bare MSRP in ${f.name} — needs strikethrough (~~) or a per-unit phrase (per serving / per cup)`,
      evidence: matches[0],
    };
  }
  return { rail: "no_msrp", pass: true };
}

function checkNoCompetitorLeak(copy: ValidatorCopy, competitorAdvertisers: string[]): ValidatorCheck {
  const fields: Array<{ name: string; value: string }> = [
    { name: "headline", value: copy.headline },
    { name: "primaryText", value: copy.primaryText },
    { name: "description", value: copy.description },
  ];
  for (const advertiser of competitorAdvertisers) {
    if (!advertiser) continue;
    const tokens = competitorTokensFor(advertiser);
    for (const token of tokens) {
      for (const f of fields) {
        const { hit, evidence } = matchesAsWholeWord(f.value, token);
        if (hit) {
          return {
            rail: "no_competitor_leak",
            pass: false,
            reason: `competitor brand token "${token}" leaked into ${f.name}`,
            evidence: evidence ?? token,
          };
        }
      }
    }
  }
  return { rail: "no_competitor_leak", pass: true };
}

function checkColdOfferGate(copy: ValidatorCopy, temperature: AudienceTemperature): ValidatorCheck {
  if (temperature !== "cold") return { rail: "cold_offer_gate", pass: true };
  if (!hasColdOfferLeak(copy)) return { rail: "cold_offer_gate", pass: true };
  return {
    rail: "cold_offer_gate",
    pass: false,
    reason: "cold-audience creative leaks offer/price language — retargets warm-shopper vocab at a viewer who's never heard of the brand",
  };
}

function checkSinglePromise(copy: ValidatorCopy): ValidatorCheck {
  const scan = `${copy.headline} ${copy.primaryText}`;
  const matches = new Set<string>();
  for (const { re } of PROMISE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan)) !== null) {
      matches.add(m[0].toLowerCase().replace(/\s+/g, " ").trim());
    }
  }
  if (matches.size <= 1) return { rail: "single_promise", pass: true };
  const list = [...matches];
  return {
    rail: "single_promise",
    pass: false,
    reason: `${matches.size} distinct promises stacked in headline + primary text — pick one`,
    evidence: list.slice(0, 3).join(" | "),
  };
}

/**
 * Pure deterministic validator — runs six rails in a fixed order and returns typed results.
 * See file header for consumer contract.
 *
 * @param copy    The candidate {headline, primaryText, description}.
 * @param brief   The CreativeBrief that produced `copy` — carried for future rails that need to
 *                cross-reference the brief's proof stack (Phase 1 doesn't read it; keeping it in
 *                the signature avoids a Phase-2 signature change on both call sites).
 * @param context Runtime context — audience temperature (for the cold-offer gate), the list of
 *                competitor advertisers to leak-scan against, and our own brand (reserved for
 *                future rails that must never flag our own tokens).
 */
export function validateGeneratedCopy(
  copy: ValidatorCopy,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  brief: CreativeBrief,
  context: ValidatorContext,
): ValidatorResult {
  const checks: ValidatorCheck[] = [
    checkLf8(copy),
    checkMetaCaps(copy),
    checkNoMsrp(copy),
    checkNoCompetitorLeak(copy, context.competitorAdvertisers),
    checkColdOfferGate(copy, context.audience_temperature),
    checkSinglePromise(copy),
  ];
  return { pass: checks.every((c) => c.pass), checks };
}
