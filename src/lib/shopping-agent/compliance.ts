/**
 * AI shopping-agent compliance module (docs/brain/libraries/shopping-agent.md · Phase 2 of the
 * AI-shopping-agent build). The HARD, in-code (never prompt) FDA/FTC dietary-supplement
 * structure/function guardrail applied to EVERY string a tool returns — benefit text, situation
 * text, quotes, FAQ/KB answers — before it leaves the MCP server.
 *
 * Nothing existing covers health claims: `safeCore` (src/lib/ad-tool-config.ts) is image-layout
 * geometry and `claim-guard` (src/lib/claim-guard.ts) covers CS effect-claims (refund/cancel) — so
 * this is a NEW, self-contained module built from the explicit rules below, NOT a reuse of either.
 *
 * Contract:
 *   - A blocked QUOTE is DROPPED (never rewritten) — see `filterQuotes`.
 *   - A blocked generated SENTENCE is DROPPED and COUNTED — see `filterText` (the count feeds the
 *     `shopping_agent_calls` blocked-claim tally for supervision).
 *   - The mandatory FDA disclaimer is exempt from the block list.
 *   - Input-side SAFETY GATE: a shopper situation mentioning pregnancy/nursing/medication/under-18/
 *     a medical condition/any block-list disease term returns the check-with-your-doctor note +
 *     contraindications and NO recommendation or quote — see `evaluateSafetyGate`.
 *
 * Every block + allow case in the spec is covered by compliance.test.ts (registered test:* script).
 */

/**
 * Mandatory disclaimer on every product payload and card. EXEMPT from the block list (it contains
 * disease-terms "diagnose, treat, cure, or prevent" by design — it is the FDA-required sentence).
 */
export const MANDATORY_DISCLAIMER =
  "These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.";

/** Short structure/function doctor note returned by the safety gate. */
export const SAFETY_GATE_NOTE =
  "Please check with your doctor before starting any supplement, especially if you are pregnant, nursing, under 18, taking medication, or managing a medical condition.";

export type BlockCategory = "disease" | "drug_comparison" | "weight_loss" | "safety_input";

/** Result of screening one string. */
export interface ClaimCheck {
  ok: boolean;
  /** When !ok, which rule caught it and the matched substring (for the supervision log / tests). */
  category?: BlockCategory;
  matched?: string;
}

/* ------------------------------------------------------------------------------------------------
 * Block lists — word-boundary, case-insensitive. Verbatim from the spec's Phase 2 rules.
 * --------------------------------------------------------------------------------------------- */

/** Disease / condition terms → block (spec Phase 2). */
const DISEASE_TERMS = [
  "cure", "cures", "cured", "treat", "treats", "treatment", "prevent", "prevents",
  "heal", "heals", "reverse", "reverses", "disease", "diabetes", "diabetic",
  "prediabetes", "A1C", "blood sugar disorder", "insulin resistance", "PCOS",
  "thyroid", "hypothyroid", "IBS", "Crohn", "colitis", "cancer", "tumor",
  "heart disease", "hypertension", "high blood pressure", "cholesterol", "arthritis",
  "depression", "anxiety disorder", "ADHD", "Alzheimer", "dementia", "obesity",
  "fatty liver", "GERD", "acid reflux", "candida", "SIBO", "infection", "virus", "COVID",
];

/** Drug comparisons → block (spec Phase 2). */
const DRUG_TERMS = [
  "GLP-1", "GLP1", "Ozempic", "Wegovy", "Mounjaro", "Zepbound", "semaglutide",
  "tirzepatide", "phentermine", "metformin", "like a prescription", "instead of medication",
];

/** Weight-loss guarantee / hype phrases — DETECTION ONLY since 2026-11-28 (adds the results-may-vary note, never blocks). */
const WEIGHT_LOSS_PHRASES = [
  // "burn fat" / "fat burner" removed — CEO 2026-11-28: "burn fat is fine".
  "guaranteed", "guarantee you will", "100% results", "melt fat",
  "detox your", "flush toxins", "miracle", "overnight results",
];

/** Units that, when a number sits next to a lose/lost/down/dropped verb, trip the quantification rule. */
const WEIGHT_UNITS = ["lb", "lbs", "pound", "pounds", "kg", "kilo", "kilos", "dress size", "dress sizes", "sizes", "inches"];

/** Input-side safety triggers (spec Phase 2 safety gate). */
const SAFETY_INPUT_TERMS = [
  "pregnant", "pregnancy", "breastfeeding", "nursing", "medication", "medications",
  "prescription", "under 18", "medical condition",
];

/** Escape a term for use inside a RegExp. */
function esc(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a case-insensitive word-boundary matcher for a term list. A leading/trailing alnum guard is
 * used instead of `\b` so hyphenated/numeric terms like `GLP-1` and `A1C` match cleanly.
 */
function buildMatcher(terms: string[]): RegExp {
  const alts = terms.map(esc).join("|");
  return new RegExp(`(?<![A-Za-z0-9])(${alts})(?![A-Za-z0-9])`, "i");
}

const DISEASE_RE = buildMatcher(DISEASE_TERMS);
const DRUG_RE = buildMatcher(DRUG_TERMS);
const WEIGHT_PHRASE_RE = buildMatcher(WEIGHT_LOSS_PHRASES);
const SAFETY_RE = buildMatcher(SAFETY_INPUT_TERMS);

/**
 * number + weight-unit adjacency, e.g. "20 lbs", "25lbs", "40+ pounds", "two dress sizes", "3 inches".
 * Vague amounts ("a few pounds", "some weight") are deliberately ALLOWED — CEO call 2026-11-28.
 */
const WEIGHT_UNIT_RE = new RegExp(
  `((?<![A-Za-z0-9.])\\d+(?:\\.\\d+)?\\+?|\\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\\b)\\s*(?:${WEIGHT_UNITS.map(esc).join("|")})(?![A-Za-z])`,
  "i",
);
/** lose/lost/down/dropped verbs that make a quantified weight claim. */
const WEIGHT_VERB_RE = /(?<![A-Za-z])(lose|lost|losing|down|dropped|drop)(?![A-Za-z])/i;

/**
 * Screen ONE string (a sentence or a short phrase) against every block rule. Returns `ok:false`
 * with the category + matched substring on the first rule hit. The disclaimer is exempt.
 */
export function checkClaim(text: string): ClaimCheck {
  if (!text || !text.trim()) return { ok: true };
  // The FDA disclaimer is exempt — it intentionally contains disease terms.
  if (text.trim() === MANDATORY_DISCLAIMER) return { ok: true };

  const drug = DRUG_RE.exec(text);
  if (drug) return { ok: false, category: "drug_comparison", matched: drug[1] };

  const disease = DISEASE_RE.exec(text);
  if (disease) return { ok: false, category: "disease", matched: disease[1] };

  // Weight-loss language is NOT blocked (CEO 2026-11-28: "no disease or drug terms"; the weight-loss
  // filter was "overzealous" and "weakening our product"). It only drives RESULTS_MAY_VARY_NOTE.
  return { ok: true };
}

/** A weight-loss result or hype phrase is present (detection only — never blocks). */
function mentionsWeightResult(text: string): boolean {
  if (WEIGHT_PHRASE_RE.test(text)) return true;
  return WEIGHT_UNIT_RE.test(text) && WEIGHT_VERB_RE.test(text);
}

/**
 * Note attached to a customer quote that reports a specific result (e.g. pounds lost). CEO rule
 * 2026-11-28: a real customer's own words are shown as written, with this note — never blocked.
 */
export const RESULTS_MAY_VARY_NOTE = "*This is an individual customer's experience. Your results may vary.";

/**
 * Screen a VERBATIM CUSTOMER QUOTE (a real review, not our copy). CEO rule 2026-11-28: "if a
 * customer put that as a review, allow it, we didn't make it up." Same rule as `checkClaim` now:
 * only disease and drug-comparison terms block; pair weight-loss results with RESULTS_MAY_VARY_NOTE
 * via `quoteNeedsResultsNote`.
 */
export function checkQuote(text: string): ClaimCheck {
  return checkClaim(text);
}

/** True when a customer quote states a weight-loss result, so the caller attaches RESULTS_MAY_VARY_NOTE. */
export function quoteNeedsResultsNote(text: string): boolean {
  return !!text && mentionsWeightResult(text);
}

/** Split text into sentences on ., !, ? boundaries (keeps it simple + deterministic). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Result of filtering a generated string: compliant sentences joined, plus a dropped count. */
export interface FilterResult {
  text: string;
  droppedCount: number;
}

/**
 * Filter a GENERATED string sentence-by-sentence: drop every non-compliant sentence (never rewrite)
 * and count the drops. Used on composed answers (FAQ/KB/RAG) before they leave the server.
 */
export function filterText(text: string): FilterResult {
  if (!text || !text.trim()) return { text: "", droppedCount: 0 };
  const sentences = splitSentences(text);
  const kept: string[] = [];
  let droppedCount = 0;
  for (const s of sentences) {
    if (checkClaim(s).ok) kept.push(s);
    else droppedCount++;
  }
  return { text: kept.join(" ").trim(), droppedCount };
}

/**
 * Filter a list of verbatim customer quotes via `checkQuote`: a quote with a disease or
 * drug-comparison hit is DROPPED whole (never rewritten); weight-loss results pass. Returns the surviving quotes + how many were dropped.
 */
export function filterQuotes<T extends { verbatim_phrase?: string | null }>(
  quotes: T[],
): { kept: T[]; droppedCount: number } {
  const kept: T[] = [];
  let droppedCount = 0;
  for (const q of quotes) {
    if (checkQuote(q.verbatim_phrase ?? "").ok) kept.push(q);
    else droppedCount++;
  }
  return { kept, droppedCount };
}

/** Result of the input-side safety gate. */
export interface SafetyGateResult {
  /** When true, the caller returns the note + contraindications and NO recommendation/quotes. */
  triggered: boolean;
  matched?: string;
  category?: BlockCategory;
  note: string;
}

/**
 * Input-side SAFETY GATE. If the shopper's situation mentions pregnancy/nursing/medication/
 * prescription/under-18/a medical condition, or ANY block-list disease term, trip the gate — the
 * caller must then return {@link SAFETY_GATE_NOTE} + the product's contraindications and nothing
 * else (no recommendation, no quote). Caffeine content is still always stated by the caller.
 */
export function evaluateSafetyGate(situationText: string): SafetyGateResult {
  const safety = SAFETY_RE.exec(situationText ?? "");
  if (safety) {
    return { triggered: true, matched: safety[1], category: "safety_input", note: SAFETY_GATE_NOTE };
  }
  // A disease term in the shopper's words is also a medical-condition signal → gate.
  const disease = DISEASE_RE.exec(situationText ?? "");
  if (disease) {
    return { triggered: true, matched: disease[1], category: "disease", note: SAFETY_GATE_NOTE };
  }
  return { triggered: false, note: SAFETY_GATE_NOTE };
}
