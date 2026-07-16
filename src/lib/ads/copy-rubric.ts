/**
 * copy-rubric — the shared 0-10 Conversion-Psychology rubric, the SSOT both the M1 author
 * session (Dahlia) and the M1 Max QC session import so their scoring cannot drift.
 *
 * The rubric is five 0-2 sub-scores that sum to a 0-10 total:
 *   - LF8         (Life-Force-8 keyword density)     — imports LF8_KEYWORDS from [[./lf8]]
 *   - Schwartz    (5 stages of awareness)
 *   - Cialdini    (7 principles of influence)
 *   - Hopkins     (specificity rules — no vague claims)
 *   - Sugarman    (slippery-slide — every line pulls the reader forward)
 *
 * Two entry points:
 *   - scoreConversionPsychology(copy, brief) — pure deterministic scorer. Returns
 *     { total, subs, evidence } where every sub-score contributes ≥1 evidence line.
 *   - renderRubricForPrompt() — the identical multi-line rubric text both downstream skill
 *     prompts embed. BYTE-STABLE across invocations (no timestamps, no interpolation, no
 *     random ordering) so Dahlia and Max render the same bytes.
 *
 * Nothing consumes this module yet. It is the SSOT foundation the downstream specs
 * (dahlia-copy-author-box-session, dahlia-max-independent-copy-qc-box-session) will import,
 * mirroring the lf8.ts pattern that keeps the ads-supervisor gate and buildMetaCopy in
 * lockstep ([[./lf8]] lines 8-9). A single edit to any sub-rubric here mutates both call
 * sites in one commit.
 *
 * DETERMINISTIC SCORING NOTES — the point is a rubric BOTH agents can render, not a
 * state-of-the-art scorer. Each sub-score is a documented pattern scan:
 *   - LF8      : 2 iff ≥2 distinct LF8_KEYWORDS hit the lowercased headline+primaryText,
 *                1 iff exactly one, 0 iff none.
 *   - Schwartz : level-detector over five word-buckets (unaware < problem-aware <
 *                solution-aware < product-aware < most-aware). 2 iff reaches
 *                product-aware or higher, 1 iff problem-aware or solution-aware,
 *                0 iff unaware.
 *   - Cialdini : counts how many of the seven principle-buckets have at least one hit
 *                in the lowercased copy. 2 iff ≥3 buckets, 1 iff 1-2, 0 iff none.
 *   - Hopkins  : counts specificity markers — digits (numbers/percents/prices), unit
 *                tokens (mg, g, oz, days, years, ingredients). 2 iff ≥3 markers,
 *                1 iff 1-2, 0 iff none.
 *   - Sugarman : slippery-slide proxy — question hooks ("?", "what if", "why", "how",
 *                "the truth", "here's", "imagine") AND multi-sentence primary text.
 *                2 iff BOTH, 1 iff either, 0 iff neither.
 */
import { LF8_KEYWORDS } from "./lf8";
import type { CreativeBrief } from "./creative-brief";

export type Copy = { headline: string; primaryText: string; description: string };

export type CopyRubricSubs = {
  lf8: 0 | 1 | 2;
  schwartz: 0 | 1 | 2;
  cialdini: 0 | 1 | 2;
  hopkins: 0 | 1 | 2;
  sugarman: 0 | 1 | 2;
};

export type CopyRubricScore = {
  total: number;
  subs: CopyRubricSubs;
  evidence: string[];
};

// ─── sub-rubric descriptors — the exact text both skill prompts embed ─────────────

export const LF8_SUBSCORE_RUBRIC = `LF8 (Life-Force-8 keyword density) — 0-2
Dr. Edward Whitman's Life-Force-8 is the eight desires ALL humans share (survival, enjoyment of
food/drink, freedom from fear/pain, sexual companionship, comfortable living, superiority,
protection of loved ones, social approval). A benefit-driven ad hits at least one; a feature-dump
ad hits none.
- 2: two or more distinct LF8 keywords appear in headline+primary text
- 1: exactly one LF8 keyword appears
- 0: zero LF8 keywords — the ad reads like a feature/spec dump`;

export const SCHWARTZ_LEVELS_1_TO_5 = `Schwartz (5 stages of awareness) — 0-2
Eugene Schwartz's 5 stages: (1) UNAWARE — reader doesn't know they have a problem; (2)
PROBLEM-AWARE — feels the pain, no solution named; (3) SOLUTION-AWARE — knows the category
of solution exists; (4) PRODUCT-AWARE — knows this specific product; (5) MOST-AWARE — needs
only price/offer to buy. Meta cold traffic is stage 1-2, warm is 3-4, retargeting is 5. Copy
must match the audience temperature — a stage-5 offer to a stage-1 viewer wastes the impression.
- 2: copy reaches stage 4 or 5 (names the product or leads with the offer/CTA)
- 1: copy is at stage 2 or 3 (names a problem or a category-level solution)
- 0: copy is at stage 1 (reader can't tell what problem this addresses)`;

export const CIALDINI_PRINCIPLES = `Cialdini (7 principles of influence) — 0-2
Robert Cialdini's 7 levers: RECIPROCITY (free gift, sample), COMMITMENT (risk-free trial,
guarantee), SOCIAL PROOF (reviews, customer count, "loved by"), AUTHORITY (doctor, expert,
clinically studied, certified), LIKING (warm we/us/our, family), SCARCITY (limited, today only,
last chance), UNITY (join us, together, our community). More levers stacked = higher pull.
- 2: three or more distinct principle-buckets have at least one hit
- 1: one or two principle-buckets have at least one hit
- 0: no principle-bucket hits — the ad has no persuasion lever wired in`;

export const HOPKINS_SPECIFICITY_RULES = `Hopkins Specificity — 0-2
Claude Hopkins (Scientific Advertising): a specific claim outsells a general one by a wide
margin. "43% fewer wrinkles in 14 days" beats "clearer skin." Specificity markers: numbers,
percentages, dollar amounts, doses (mg/g/oz), timeframes (days, weeks), quantities (servings,
ingredients).
- 2: three or more distinct specificity markers appear in the copy
- 1: one or two specificity markers appear
- 0: no specificity markers — every claim is vague ("better," "amazing," "the best")`;

export const SUGARMAN_SLIPPERY_SLIDE = `Sugarman Slippery-Slide — 0-2
Joe Sugarman's rule: the SOLE purpose of the first sentence is to get you to read the second;
the second, to get you to read the third. Curiosity hooks ("what if", "why", "how", "the
truth", "here's", "imagine", or a direct question) plus a multi-sentence body keep the reader
sliding.
- 2: copy has a curiosity hook AND primary text has multiple sentences
- 1: copy has a curiosity hook OR multi-sentence primary text (not both)
- 0: neither — the copy is a flat one-line statement with no pull`;

// ─── deterministic sub-scorers ────────────────────────────────────────────────────

function joinedLower(copy: Copy): string {
  return `${copy.headline} ${copy.primaryText}`.toLowerCase();
}

function scoreLf8(copy: Copy, evidence: string[]): 0 | 1 | 2 {
  const joined = joinedLower(copy);
  const hits = new Set<string>();
  for (const kw of LF8_KEYWORDS) if (joined.includes(kw)) hits.add(kw);
  const n = hits.size;
  if (n >= 2) {
    evidence.push(`lf8=2 (${n} keywords: ${[...hits].slice(0, 6).join(", ")})`);
    return 2;
  }
  if (n === 1) {
    evidence.push(`lf8=1 (1 keyword: ${[...hits][0]})`);
    return 1;
  }
  evidence.push(`lf8=0 (no Life-Force-8 keywords in headline+primary text)`);
  return 0;
}

// Schwartz word buckets — deliberately narrow, deterministic proxies for each stage.
const SCHWARTZ_PROBLEM_AWARE: readonly string[] = [
  "tired", "exhausted", "crash", "afternoon slump", "brain fog", "bloat", "bloated",
  "stressed", "anxious", "sluggish", "worn out", "burnt out", "drained", "foggy",
];
const SCHWARTZ_SOLUTION_AWARE: readonly string[] = [
  "coffee", "supplement", "capsule", "powder", "creamer", "drink", "shake",
  "vitamin", "protein", "collagen", "probiotic",
];
const SCHWARTZ_MOST_AWARE: readonly string[] = [
  "save", "off", "free shipping", "deal", "today", "buy now", "order now",
  "% off", "$ off",
];

function scoreSchwartz(copy: Copy, brief: CreativeBrief, evidence: string[]): 0 | 1 | 2 {
  const joined = joinedLower(copy);
  const productTitle = (brief.productTitle || "").toLowerCase().trim();
  const productAware =
    productTitle.length >= 3 && joined.includes(productTitle);
  const mostAware = SCHWARTZ_MOST_AWARE.some((kw) => joined.includes(kw));
  const solutionAware = SCHWARTZ_SOLUTION_AWARE.some((kw) => joined.includes(kw));
  const problemAware = SCHWARTZ_PROBLEM_AWARE.some((kw) => joined.includes(kw));

  if (productAware || mostAware) {
    const label = productAware ? "product-aware (names product)" : "most-aware (offer/CTA)";
    evidence.push(`schwartz=2 (${label})`);
    return 2;
  }
  if (solutionAware || problemAware) {
    const label = solutionAware ? "solution-aware (category)" : "problem-aware (pain named)";
    evidence.push(`schwartz=1 (${label})`);
    return 1;
  }
  evidence.push(`schwartz=0 (unaware — no problem, solution, product, or offer signaled)`);
  return 0;
}

// Cialdini principle buckets — one bucket = one principle. Copy hits a bucket if ANY term hits.
const CIALDINI_BUCKETS: readonly { name: string; terms: readonly string[] }[] = [
  { name: "reciprocity", terms: ["free", "gift", "sample", "bonus"] },
  { name: "commitment", terms: ["risk-free", "guarantee", "money-back", "try", "no risk"] },
  { name: "social-proof", terms: ["reviews", "customers", "loved by", "trusted by", "5-star", "★"] },
  { name: "authority", terms: ["doctor", "expert", "clinically", "certified", "phd", "researcher"] },
  { name: "liking", terms: [" we ", " our ", " us ", "family", "our team"] },
  { name: "scarcity", terms: ["limited", "today only", "last", "while supplies", "only", "few left"] },
  { name: "unity", terms: ["join", "together", "community", "our tribe", "we're"] },
];

function scoreCialdini(copy: Copy, evidence: string[]): 0 | 1 | 2 {
  // Pad with spaces so " we " / " our " word-boundary probes hit at start/end of the string.
  const joined = ` ${joinedLower(copy)} `;
  const hits: string[] = [];
  for (const bucket of CIALDINI_BUCKETS) {
    if (bucket.terms.some((t) => joined.includes(t))) hits.push(bucket.name);
  }
  if (hits.length >= 3) {
    evidence.push(`cialdini=2 (${hits.length} principles: ${hits.slice(0, 4).join(", ")})`);
    return 2;
  }
  if (hits.length >= 1) {
    evidence.push(`cialdini=1 (${hits.length} principle${hits.length === 1 ? "" : "s"}: ${hits.join(", ")})`);
    return 1;
  }
  evidence.push(`cialdini=0 (no persuasion principles wired in)`);
  return 0;
}

// Hopkins specificity markers — digits + unit tokens.
const HOPKINS_UNIT_TOKENS: readonly string[] = [
  "mg", " g ", " g,", " g.", "oz", "day", "days", "week", "weeks", "month", "months",
  "year", "years", "hour", "hours", "minute", "minutes", "serving", "servings",
  "ingredient", "ingredients",
];

function scoreHopkins(copy: Copy, evidence: string[]): 0 | 1 | 2 {
  const joined = joinedLower(copy);
  const markers: string[] = [];
  const digitMatches = joined.match(/\d+/g);
  if (digitMatches && digitMatches.length > 0) {
    // Each distinct digit run counts as one marker (capped at a small ceiling by dedup).
    const uniq = new Set(digitMatches);
    for (const d of uniq) markers.push(`num:${d}`);
  }
  for (const u of HOPKINS_UNIT_TOKENS) {
    if (joined.includes(u)) markers.push(`unit:${u.trim() || u}`);
  }
  if (markers.length >= 3) {
    evidence.push(`hopkins=2 (${markers.length} specificity markers: ${markers.slice(0, 4).join(", ")})`);
    return 2;
  }
  if (markers.length >= 1) {
    evidence.push(`hopkins=1 (${markers.length} specificity marker${markers.length === 1 ? "" : "s"}: ${markers.join(", ")})`);
    return 1;
  }
  evidence.push(`hopkins=0 (no specificity markers — every claim is vague)`);
  return 0;
}

// Sugarman slippery-slide hooks.
const SUGARMAN_HOOKS: readonly string[] = [
  "?", "what if", "why ", "how ", "the truth", "here's", "here is", "imagine", "picture this",
];

function scoreSugarman(copy: Copy, evidence: string[]): 0 | 1 | 2 {
  const headlineLower = copy.headline.toLowerCase();
  const primaryLower = copy.primaryText.toLowerCase();
  const combined = `${headlineLower} ${primaryLower}`;
  const hasHook = SUGARMAN_HOOKS.some((h) => combined.includes(h));
  const sentences = copy.primaryText.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  const multiSentence = sentences.length >= 2;

  if (hasHook && multiSentence) {
    evidence.push(`sugarman=2 (curiosity hook + ${sentences.length} sentences in primary text)`);
    return 2;
  }
  if (hasHook) {
    evidence.push(`sugarman=1 (curiosity hook, primary text is a single sentence)`);
    return 1;
  }
  if (multiSentence) {
    evidence.push(`sugarman=1 (multi-sentence primary text, no curiosity hook)`);
    return 1;
  }
  evidence.push(`sugarman=0 (flat one-line copy with no hook)`);
  return 0;
}

/**
 * Pure deterministic scorer. Same inputs → same outputs, byte-for-byte, no I/O.
 * Returns per-sub scores, evidence lines (≥1 per sub-score), and a total clamped to 0..10.
 */
export function scoreConversionPsychology(copy: Copy, brief: CreativeBrief): CopyRubricScore {
  const evidence: string[] = [];
  const subs: CopyRubricSubs = {
    lf8: scoreLf8(copy, evidence),
    schwartz: scoreSchwartz(copy, brief, evidence),
    cialdini: scoreCialdini(copy, evidence),
    hopkins: scoreHopkins(copy, evidence),
    sugarman: scoreSugarman(copy, evidence),
  };
  const rawTotal = subs.lf8 + subs.schwartz + subs.cialdini + subs.hopkins + subs.sugarman;
  const total = Math.max(0, Math.min(10, rawTotal));
  return { total, subs, evidence };
}

/**
 * Byte-stable rubric text both downstream skill prompts embed verbatim so Dahlia and Max
 * render THE SAME BYTES. A change to any sub-rubric here mutates both call sites in one
 * commit, mirroring the LF8_KEYWORDS SSOT pattern.
 */
export function renderRubricForPrompt(): string {
  return [
    "# Conversion-Psychology Rubric (0-10)",
    "",
    "Score each sub-dimension 0, 1, or 2. Sum the five sub-scores for the total.",
    "",
    LF8_SUBSCORE_RUBRIC,
    "",
    SCHWARTZ_LEVELS_1_TO_5,
    "",
    CIALDINI_PRINCIPLES,
    "",
    HOPKINS_SPECIFICITY_RULES,
    "",
    SUGARMAN_SLIPPERY_SLIDE,
  ].join("\n");
}
