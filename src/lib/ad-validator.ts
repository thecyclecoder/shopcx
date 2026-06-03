/**
 * Direct Response Validator — the refuse-to-ship gate.
 *
 * Called by the script generator (Phase 3, retries up to 3x) AND again as a hard
 * pre-encode gate at render time (Phase 5). No ad ships that fails validation;
 * there is no "are you sure" override — the gate is opinionated by design.
 *
 * See docs/brain/specs/ad-tool.md Phase 0.5 §C.
 */
import {
  DEFAULT_BANNED_WORDS,
  BANNED_OPENERS,
  SOFT_CTA_PHRASES,
  META_CAPS,
  MAX_SPOKEN_SECONDS,
} from "@/lib/ad-tool-config";
import type { AngleGeneratorInput, ProductAdAngle } from "@/lib/ad-types";

export interface Violation {
  code: string;
  severity: "fatal" | "warn";
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

// Spoken-word rate used to estimate duration from a script (≈ 2.6 words/sec VO).
const WORDS_PER_SECOND = 2.6;

const FEATURE_LED_TERMS = [
  "ingredient", "ingredients", "sourced", "sourcing", "certified", "certification",
  "organic", "gmp", "manufactured", "formula", "formulation", "milligram", "mg of",
  "extract", "blend of", "contains",
];

export interface ValidateOpts {
  bannedWords?: string[]; // workspace-configurable; falls back to defaults
}

/** Normalize for substring matching. */
function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

/** The first ~5 spoken seconds of the script (roughly the first 13 words). */
function firstSecondsWords(script: string, seconds: number): string {
  const words = norm(script).split(" ").filter(Boolean);
  return words.slice(0, Math.ceil(seconds * WORDS_PER_SECOND)).join(" ");
}

/** Estimated spoken duration of the full script, in seconds. */
export function estimateSpokenSeconds(script: string): number {
  const n = norm(script).split(" ").filter(Boolean).length;
  return n / WORDS_PER_SECOND;
}

/**
 * Build the set of anchor phrases (tier 1 + tier 2 + tier-3 benefit headlines)
 * a claim can legitimately trace back to.
 */
function anchorPhrases(inputs: AngleGeneratorInput): string[] {
  const phrases: string[] = [];
  for (const b of inputs.benefit_bar || []) if (b?.text) phrases.push(norm(b.text));
  for (const lb of inputs.lead_benefits || []) {
    if (lb?.name) phrases.push(norm(lb.name));
    for (const cp of lb.customer_phrases || []) phrases.push(norm(cp));
  }
  for (const sci of inputs.ingredient_science || []) {
    if (sci?.benefit_headline) phrases.push(norm(sci.benefit_headline));
  }
  if (inputs.hero_headline) phrases.push(norm(inputs.hero_headline));
  if (inputs.hero_subheadline) phrases.push(norm(inputs.hero_subheadline));
  return phrases.filter(Boolean);
}

/** Stopword-light noun-phrase-ish keyword extraction from a sentence. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "if", "you", "your", "i", "we", "they", "this",
  "that", "it", "to", "of", "in", "on", "for", "with", "is", "are", "was", "were", "be",
  "been", "have", "has", "had", "do", "does", "did", "will", "can", "just", "so", "before",
  "after", "now", "then", "out", "up", "down", "get", "got", "stop", "start", "every", "all",
]);

function contentKeywords(sentence: string): string[] {
  return norm(sentence)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .filter((w) => w.length > 3 && !STOP.has(w));
}

/**
 * A central claim is considered anchored if a meaningful share of its content
 * keywords appear inside one of the anchor phrases.
 */
function claimIsAnchored(sentence: string, anchors: string[]): boolean {
  const kws = contentKeywords(sentence);
  if (kws.length === 0) return true; // no real claim in this sentence
  const blob = anchors.join(" | ");
  const hits = kws.filter((k) => blob.includes(k)).length;
  return hits / kws.length >= 0.34; // at least a third of the claim's keywords trace back
}

/** Split a script body into central-claim sentences (skips hook label lines). */
function bodySentences(script: string): string[] {
  return script
    .replace(/^(hook|body|cta)\s*:/gim, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Does this sentence read as a cited review quote rather than a bare claim? */
function isCitedReview(sentence: string): boolean {
  const n = norm(sentence);
  return /real customer|reviewer|review|—\s*\w|".+"|'.+'/.test(n) && /["']/.test(sentence);
}

// Verbs that signal a sentence is asserting what the PRODUCT does (a claim that
// must trace to a source) vs. problem/agitation framing about the category
// (which is exempt — "most coffee spikes you then drops you" is not a product claim).
const SOLUTION_VERBS = [
  "gives", "give", "delivers", "deliver", "crushes", "crush", "ends", "end", "kills", "kill",
  "fixes", "fix", "melts", "melt", "burns", "burn", "clears", "clear", "restores", "restore",
  "eliminates", "eliminate", "curbs", "curb", "fights", "fight", "shed", "sheds", "torches",
  "torch", "unlocks", "unlock", "you get", "you'll", "makes you", "keeps you", "gets you",
];

/**
 * A sentence requires anchoring only when it asserts something the product/solution
 * DOES — it mentions the product by name OR uses a solution verb. Pure problem-
 * agitation sentences (the customer's pain, the category enemy) are exempt.
 */
function isProductClaimSentence(sentence: string, productTitle: string): boolean {
  const n = norm(sentence);
  if (productTitle && n.includes(norm(productTitle))) return true;
  return SOLUTION_VERBS.some((v) => new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(n));
}

export function validateAdScript(
  script: string,
  angle: Pick<ProductAdAngle, "meta_headline" | "meta_primary_text" | "meta_description" | "proof_anchor"> | null,
  inputs: AngleGeneratorInput,
  opts: ValidateOpts = {},
): ValidationResult {
  const violations: Violation[] = [];
  const banned = (opts.bannedWords && opts.bannedWords.length ? opts.bannedWords : DEFAULT_BANNED_WORDS).map(norm);
  const anchors = anchorPhrases(inputs);
  const nScript = norm(script);

  // 1. Opener pattern — brand name OR warm intro.
  const firstLine = bodySentences(script)[0] || "";
  const firstWord = norm(firstLine).split(" ")[0] || "";
  if (BANNED_OPENERS.includes(firstWord)) {
    violations.push({ code: "warm_opener", severity: "fatal", message: `Opener "${firstWord}" is a warm intro. Hook must land in frame 1.` });
  }
  if (inputs.product_title && norm(firstLine).startsWith(norm(inputs.product_title))) {
    violations.push({ code: "brand_first_opener", severity: "fatal", message: "Opener leads with the brand/product name. Open on the customer's pain, not the product." });
  }

  // 2. Feature-led opener — ingredients/sourcing/certs in the first 5 spoken seconds.
  const opener = firstSecondsWords(script, 5);
  for (const term of FEATURE_LED_TERMS) {
    if (opener.includes(term)) {
      violations.push({ code: "feature_led_opener", severity: "fatal", message: `Feature-led opener: "${term}" appears in the first 5 seconds. Lead with what the customer feels; ingredients are supporting evidence later.` });
      break;
    }
  }

  // 3. Banned soft words.
  for (const w of banned) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(nScript)) {
      violations.push({ code: "banned_word", severity: "fatal", message: `Banned soft word: "${w}".` });
    }
  }

  // 4. Soft CTA.
  for (const phrase of SOFT_CTA_PHRASES) {
    if (nScript.includes(phrase)) {
      violations.push({ code: "soft_cta", severity: "fatal", message: `Soft CTA "${phrase}". Use an imperative + urgency.` });
      break;
    }
  }

  // 5. Length cap.
  const secs = estimateSpokenSeconds(script);
  if (secs > MAX_SPOKEN_SECONDS) {
    violations.push({ code: "too_long", severity: "fatal", message: `Script is ~${secs.toFixed(0)}s spoken, over the ${MAX_SPOKEN_SECONDS}s cap.` });
  }

  // 6. Claim-anchoring + review-as-promise.
  const sentences = bodySentences(script);
  let anchoredCentralClaim = false;
  for (const s of sentences) {
    if (isCitedReview(s)) continue; // cited reviews are allowed as backing, not central
    if (!isProductClaimSentence(s, inputs.product_title)) continue; // problem/agitation framing is exempt
    if (contentKeywords(s).length < 2) continue;
    if (claimIsAnchored(s, anchors)) {
      anchoredCentralClaim = true;
    } else {
      violations.push({ code: "unanchored_claim", severity: "fatal", message: `Claim "${s.slice(0, 70)}…" is not backed by a tier-1 or tier-2 source.` });
    }
  }
  // Promise without anchor: nothing in the script traced to tiers 1-2, yet a
  // review quote is present → the promise is riding on a review.
  if (!anchoredCentralClaim && sentences.some(isCitedReview)) {
    violations.push({ code: "review_as_promise", severity: "fatal", message: "The central promise rests on a review quote with no tier-1/tier-2 anchor. Reviews can cite, never lead." });
  }

  // 7. Meta cap overflow (when an angle's meta copy is supplied).
  if (angle) {
    if (angle.meta_headline && angle.meta_headline.length > META_CAPS.headline) {
      violations.push({ code: "meta_headline_overflow", severity: "fatal", message: `meta_headline ${angle.meta_headline.length} > ${META_CAPS.headline}.` });
    }
    if (angle.meta_primary_text && angle.meta_primary_text.length > META_CAPS.primary_text) {
      violations.push({ code: "meta_primary_overflow", severity: "fatal", message: `meta_primary_text ${angle.meta_primary_text.length} > ${META_CAPS.primary_text}.` });
    }
    if (angle.meta_description && angle.meta_description.length > META_CAPS.description) {
      violations.push({ code: "meta_description_overflow", severity: "fatal", message: `meta_description ${angle.meta_description.length} > ${META_CAPS.description}.` });
    }
  }

  const fatal = violations.filter((v) => v.severity === "fatal");
  return { ok: fatal.length === 0, violations };
}

/**
 * Validate a generated angle in isolation (used by the generator before insert):
 * the lead_benefit_anchor must be verbatim from benefit_bar[].text OR
 * lead_benefits[].name, and the meta fields must respect the caps.
 */
export function validateAngle(angle: ProductAdAngle, inputs: AngleGeneratorInput): ValidationResult {
  const violations: Violation[] = [];
  const validAnchors = new Set<string>([
    ...(inputs.benefit_bar || []).map((b) => norm(b.text)),
    ...(inputs.lead_benefits || []).map((b) => norm(b.name)),
  ]);
  if (!validAnchors.has(norm(angle.lead_benefit_anchor))) {
    violations.push({ code: "anchor_not_verbatim", severity: "fatal", message: `lead_benefit_anchor "${angle.lead_benefit_anchor}" is not a verbatim benefit_bar or lead_benefit.` });
  }
  if ((angle.meta_headline || "").length > META_CAPS.headline) violations.push({ code: "meta_headline_overflow", severity: "fatal", message: "meta_headline over 40." });
  if ((angle.meta_primary_text || "").length > META_CAPS.primary_text) violations.push({ code: "meta_primary_overflow", severity: "fatal", message: "meta_primary_text over 125." });
  if ((angle.meta_description || "").length > META_CAPS.description) violations.push({ code: "meta_description_overflow", severity: "fatal", message: "meta_description over 30." });
  return { ok: violations.length === 0, violations };
}
