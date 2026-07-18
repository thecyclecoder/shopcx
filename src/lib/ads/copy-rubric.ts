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
  /** dahlia-hooks-riff-competitor-angle-and-weave-in-lead-benefit Phase 3 (2026-07-18) —
   *  advisory-soft signal that DEDUCTS 1 point from the total when the brief carries a
   *  `leadBenefitWeave` (the Phase 2 competitor-riff marker) AND the headline does not
   *  touch that lead benefit. NEVER a hard gate: a competitor riff whose hook still scores
   *  well on the other five sub-scores can still clear a floor and ship; the minority
   *  explore slot's pure-competitor brief has `leadBenefitWeave=null` so the penalty
   *  cannot fire on it. `0` = no penalty · `-1` = the soft deduction applied. */
  leadBenefitPenalty: 0 | -1;
  evidence: string[];
};

// ─── sub-rubric descriptors — the exact text both skill prompts embed ─────────────

export const LF8_SUBSCORE_RUBRIC = `LF8 (Life-Force-8 keyword density) — 0-2
Dr. Edward Whitman's Life-Force-8 is the eight desires ALL humans share (survival, enjoyment of
food/drink, freedom from fear/pain, sexual companionship, comfortable living, superiority,
protection of loved ones, social approval). A benefit-driven ad hits at least one; a feature-dump
ad hits none.
Benefits-not-product (Cashvertising, advisory-soft) — LF8 counts keywords because those
keywords ARE the reader's benefit vocabulary. Lead every headline and primary text with the
OUTCOME the reader gets (the transformation, the feeling, the pain removed) — the product is
only the vehicle, the benefit is the promise. Strongest for COLD audiences (Schwartz 1-2):
they do not know the brand yet, they only care about the outcome; a product-led opener
buries the benefit behind the SKU and typically scores 0-1 on this axis.
- Reward a benefit-led opener that names the reader's outcome in the first line (LF8
  keywords surface naturally): "feel lighter", "steady focus, no crash", "curb the
  cravings", "sleep through the night".
- Dock a product-led opener that names the product/brand before the benefit:
  "Amazing Coffee is a mushroom coffee that…", "Meet Superfoods…", "Our formula contains…"
  — the benefit is downstream, LF8 fires late (or not at all), the axis drops.
- Dock a feature/ingredient list opener ("With lion's mane, chaga, and cordyceps…") — a
  feature-dump lists what's in the box, not what the reader gets, so the keywords rarely
  hit.
Advisory-soft — this is the AUTHORING intent behind the deterministic keyword-density count;
the scorer stays the same simple hit-counter, and the guidance is what pushes both Dahlia
(self-score) and Max (QC) to write in a way that makes the count land honestly.
- 2: two or more distinct LF8 keywords appear in headline+primary text (usually the sign of
     a benefit-led opener)
- 1: exactly one LF8 keyword appears (a mixed opener — one benefit token, otherwise
     product/feature)
- 0: zero LF8 keywords — the ad reads like a feature/spec dump or a product-led opener with
     no benefit surfaced`;

export const SCHWARTZ_LEVELS_1_TO_5 = `Schwartz (5 stages of awareness) — 0-2
Eugene Schwartz's 5 stages: (1) UNAWARE — reader doesn't know they have a problem; (2)
PROBLEM-AWARE — feels the pain, no solution named; (3) SOLUTION-AWARE — knows the category
of solution exists; (4) PRODUCT-AWARE — knows this specific product; (5) MOST-AWARE — needs
only price/offer to buy. Meta cold traffic is stage 1-2, warm is 3-4, retargeting is 5. Copy
must match the audience temperature — a stage-5 offer to a stage-1 viewer wastes the impression.
Write AT the market's sophistication level; NEVER below level-1. When competitors have all
moved to L4 mechanism, an L2 problem-aware ad reads as a decade behind and never converts.
Two examples per level (voice + shape you're writing FOR):
- L1 UNAWARE — 'most people don't realize how much afternoon crashes cost them' ·
  'the average worker loses two productive hours a day and never notices where they went'
- L2 PROBLEM-AWARE — 'tired of the 2pm crash?' ·
  'still fighting brain fog every afternoon?'
- L3 SOLUTION-AWARE — 'a cleaner afternoon lift' ·
  'the plant-based focus drink category is having a moment'
- L4 PRODUCT-AWARE — 'adaptogens + L-theanine, no crash' ·
  'the ashwagandha + lion's mane stack that replaces your third cup'
- L5 MOST-AWARE — 'vs coffee alone: 47 fewer crash calories, +2h focus' ·
  'today only: 30% off the stack 12,000 members already run'
- 2: copy reaches stage 4 or 5 (names the product or leads with the offer/CTA)
- 1: copy is at stage 2 or 3 (names a problem or a category-level solution)
- 0: copy is at stage 1 (reader can't tell what problem this addresses)`;

export const CIALDINI_PRINCIPLES = `Cialdini (7 principles of influence) — 0-2
Robert Cialdini's 7 levers. More distinct levers stacked = higher pull. Do NOT stack the same
lever twice and call it two hits — the rubric counts distinct principle BUCKETS, not repeats.
One line per principle + a one-line example you can steal the SHAPE of:
- RECIPROCITY — give first, ask second.
  example: 'free 7-day starter pack — try before you commit.'
- COMMITMENT — a small yes now sets up the bigger yes.
  example: 'risk-free 30-day trial — cancel any time, no questions.'
- SOCIAL PROOF — people who look like the reader are already in.
  example: '12,438 customers rated it 4.8/5 — loved by moms, coaches, night-shift nurses.'
- AUTHORITY — an expert or study says so, on the record.
  example: 'formulated with a naturopathic doctor · clinically studied ingredients.'
- LIKING — warm, in-group, first-person voice ("we", "our", "us", "family").
  example: 'we built this for our own team — now it's yours.'
- SCARCITY — limited by time or count, and true.
  example: 'first 500 bags of the fall harvest — restock in January.'
- UNITY — you and the reader belong to the same tribe.
  example: 'join the 10,000 members who ditched the third coffee.'
- 2: three or more distinct principle-buckets have at least one hit
- 1: one or two principle-buckets have at least one hit
- 0: no principle-bucket hits — the ad has no persuasion lever wired in`;

export const HOPKINS_SPECIFICITY_RULES = `Hopkins Specificity — 0-2
Claude Hopkins (Scientific Advertising): a specific claim outsells a general one by a wide
margin. "43% fewer wrinkles in 14 days" beats "clearer skin." Specificity markers: numbers,
percentages, dollar amounts, doses (mg/g/oz), timeframes (days, weeks), quantities (servings,
ingredients).
Three concrete authoring rules — apply on every line before shipping:
- Rule 1: replace "many" with an exact count.
  before: 'many customers noticed the change' · after: '4,182 customers noticed the change'
- Rule 2: replace "quickly" with a real timeframe in days or minutes.
  before: 'starts working quickly' · after: 'starts working in 14 days (or 20 minutes for focus)'
- Rule 3: replace "people" with a real named reviewer.
  before: 'people say it changed their afternoons' · after: 'Marissa D. (verified) says it changed her afternoons'
- 2: three or more distinct specificity markers appear in the copy
- 1: one or two specificity markers appear
- 0: no specificity markers — every claim is vague ("better," "amazing," "the best")`;

export const LEAD_BENEFIT_SIGNAL = `Lead-benefit signal (soft) — 0 / −1
Advisory-soft (never a hard gate). When the brief carries a \`leadBenefitWeave\` — the
Phase-2 marker that this creative is a competitor RIFF and MUST blend our differentiated
lead benefit with the competitor's proven framework — the headline is expected to touch
that lead benefit somewhere in its words. A hook that leads with a purely borrowed
commodity retention truth ("no jitters" / "no crash" / "tired of the coffee jitters?") while
the lead benefit is absent LOSES ONE POINT. A hook that BLENDS the lead benefit with the
competitor angle — soft phrasing OK, verbatim from \`leadBenefitWeave.softPhrasings\` or the
\`benefitName\` — earns 0 (no penalty). The point-value penalty is intentionally SOFT so a
deliberately-explore competitor angle can still clear the floor on the other five
sub-scores; a MINORITY explore slot per batch has \`leadBenefitWeave=null\` and cannot
receive this penalty at all. North-star example (CEO 2026-07-18): for Amazing Coffee with
\`leadBenefitWeave.benefitName='Weight loss'\` and softPhrasings \`['feel lighter', 'lost
weight', ...]\`, a headline of "Tasty coffee, feel lighter, no jitters" earns 0 (the RIFF
present); "Tired of the coffee jitters?" earns −1 (pure borrow — differentiator absent).
- 0: brief has no \`leadBenefitWeave\` (own-brand angle OR pure-competitor explore slot) OR
     the headline contains the benefit name, a soft-phrasing verbatim, or a distinctive
     word from the benefit name — the RIFF is present
- −1: brief carries a \`leadBenefitWeave\` AND the headline touches NONE of the above — the
     ad leads with a borrowed commodity truth and the differentiator is buried`;

export const SUGARMAN_SLIPPERY_SLIDE = `Sugarman Slippery-Slide — 0-2
Joe Sugarman's rule: the SOLE purpose of the first sentence is to get you to read the second;
the second, to get you to read the third. Every line earns the next line, or gets cut.
Curiosity hooks ("what if", "why", "how", "the truth", "here's", "imagine", or a direct
question) plus a multi-sentence body keep the reader sliding.
Scroll-stop + ellipsis-aware opener (advisory-soft) — Meta truncates primary text after
roughly the first 1-2 lines with a '...more' ellipsis, so the OPENING 1-2 lines carry the
entire scroll-stop burden. Those lines must be a curiosity / unexpected / contrarian
pattern-interrupt that MAKES a scrolling reader think 'wait, what?' and tap '...more' —
NOT a product intro, NOT a flat benefit-list summary, NOT a feature/ingredient list.
- Reward a primary text whose opening (pre-ellipsis) 1-2 lines are a curiosity / unexpected
  / contrarian pattern-interrupt that leads with the reader's BENEFIT: an open loop ("The
  one thing every coffee drinker gets wrong…"), a reversal ("Everyone said cut back on
  coffee. She did the opposite."), a contrarian claim ("Cutting calories is why the weight
  came back."), a pattern-interrupt story ("Kaitlyn was down 40 lbs before she noticed her
  cravings were gone.").
- Dock a product-led opener ("<Product> is a mushroom coffee that…", "Meet <Brand>…",
  "Our formula contains…") — the reader has no reason to expand past the ellipsis.
- Dock a flat one-line benefit-summary that gives the whole promise away before the
  ellipsis ("Lose weight, feel great, no jitters.") — a summary tells the reader they are
  done; there is nothing left behind '...more'.
- Dock a feature / ingredient list opener ("With lion's mane, chaga, and cordyceps…") —
  the reader is scrolling for outcomes, not for a bill of materials.
Advisory-soft — this is the AUTHORING intent behind the deterministic hook + multi-sentence
scorer; the axis stays a simple 0-2 within the 0-10 self-score (never a hard gate). A hook
strong enough to earn 2 despite an average score elsewhere is exactly the shape the
scroll-stop rule rewards; a flat or product-led opener drops the axis regardless of how
many sentences follow.
Four line-earns-the-next micro-rules — apply in order when authoring:
- Micro-rule 1: first sentence ≤ 1-second reading time. If a scroller can't finish the opener
  in a beat, they never see the second. Cut adjectives until it fits.
- Micro-rule 2: each line ends on a curiosity gap, not a period the reader can rest on. A
  finished thought is a stop signal — leave a question, a promise, or a specific next detail.
- Micro-rule 3: no benefit line follows another benefit line — alternate benefit / proof /
  benefit / proof so every claim earns credibility before the next claim asks for attention.
- Micro-rule 4: the last line invites the click, does not summarize. A summary tells the
  reader they're done; a soft CTA ("see it before it restocks") slides them to the button.
- 2: copy has a curiosity hook AND primary text has multiple sentences (front-loaded
     curiosity+benefit opener that earns the '...more' expand)
- 1: copy has a curiosity hook OR multi-sentence primary text (not both) — the opener
     earns some expand but not both
- 0: neither — a flat one-line statement, a product-led opener, or a benefit-list summary
     with no pull past the ellipsis`;

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

// Lead-benefit signal — dahlia-hooks-riff-competitor-angle-and-weave-in-lead-benefit Phase 3
// (2026-07-18). Advisory-soft deduction: fires ONLY when the brief's `leadBenefitWeave` is
// populated (the Phase-2 competitor-riff marker). A pure-competitor explore slot has
// `leadBenefitWeave=null` so the penalty cannot fire on it; an own-brand angle likewise leaves
// the field null and is unaffected. Match is lowercase substring against benefit_name +
// softPhrasings + individual distinctive words (≥5 chars) from benefit_name.
function scoreLeadBenefitSignal(copy: Copy, brief: CreativeBrief, evidence: string[]): 0 | -1 {
  const weave = brief.leadBenefitWeave;
  if (!weave || !weave.benefitName) {
    evidence.push(
      "lead_benefit_penalty=0 (brief carries no leadBenefitWeave — own-brand angle or minority pure-competitor explore slot; the soft rail is silent)",
    );
    return 0;
  }
  const headline = (copy.headline || "").toLowerCase();
  const benefitLower = weave.benefitName.toLowerCase().trim();
  const tokens = new Set<string>();
  if (benefitLower) tokens.add(benefitLower);
  for (const p of weave.softPhrasings ?? []) {
    const pLower = String(p ?? "").toLowerCase().trim();
    if (pLower) tokens.add(pLower);
  }
  for (const word of benefitLower.split(/\s+/)) if (word.length >= 5) tokens.add(word);
  const hit = [...tokens].find((t) => t.length > 0 && headline.includes(t));
  if (hit) {
    evidence.push(
      `lead_benefit_penalty=0 (RIFF present — headline touches '${hit}' from leadBenefitWeave)`,
    );
    return 0;
  }
  evidence.push(
    `lead_benefit_penalty=-1 (soft: brief requires the RIFF but the headline touches no lead-benefit token — benefit_name='${weave.benefitName}', softPhrasings=${JSON.stringify((weave.softPhrasings ?? []).slice(0, 3))})`,
  );
  return -1;
}

/**
 * Pure deterministic scorer. Same inputs → same outputs, byte-for-byte, no I/O.
 * Returns per-sub scores, evidence lines (≥1 per sub-score), and a total clamped to 0..10.
 * Phase 3 (2026-07-18) — a `leadBenefitPenalty` of −1 (soft) may deduct one point from the
 * total when the brief carries a `leadBenefitWeave` and the headline ignores it.
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
  const leadBenefitPenalty = scoreLeadBenefitSignal(copy, brief, evidence);
  const rawTotal = subs.lf8 + subs.schwartz + subs.cialdini + subs.hopkins + subs.sugarman + leadBenefitPenalty;
  const total = Math.max(0, Math.min(10, rawTotal));
  return { total, subs, leadBenefitPenalty, evidence };
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
    "Score each sub-dimension 0, 1, or 2. Sum the five sub-scores for the total, then apply the",
    "Phase-3 soft LEAD-BENEFIT SIGNAL (0 or −1) as a total-level adjustment. The final total is",
    "clamped to 0..10.",
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
    "",
    LEAD_BENEFIT_SIGNAL,
  ].join("\n");
}
