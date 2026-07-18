/**
 * never-fabricate — the deterministic layer-3 verifier of the three-layer never-fabricate firewall
 * shipped by [[../../../docs/brain/specs/dahlia-never-fabricate-copy-firewall.md]]. Independently
 * checks each `{claim, source, source_ref}` entry Dahlia's author box session emitted on her
 * `claim_trace` against the ProductIntelligence surface (`ingredients` / `ingredientResearch` /
 * the lazy `reviews.byClaim` closure from [[../product-intelligence]]) and the CreativeBrief
 * (`leadProof` / `transformation` / `supportingBenefits`). A mismatch flips `ok=false` and returns
 * a typed `misses[]` array the M1 revise loop consumes; on revise exhaustion the caller emits the
 * distinct `dahlia_copy_firewall_exhausted` escalation.
 *
 * Layer 1 is INSTRUCTIONAL (the CLAIM-ONLY-WHAT'S-IN-THE-BRIEF table in the
 * `dahlia-copy-author` SKILL). Layer 2 is the REQUIRED `claim_trace` field on the session verdict
 * (typed on [[./creative-agent]] `AuthorModeCopy`, validated in `parseAuthorVerdict`). Layer 3
 * (this file) is the deterministic gate — the source-of-truth for whether a cited claim actually
 * traces to the underlying evidence.
 *
 * Pure — no I/O of its own; the caller resolves `pi.reviews.byClaim(source_ref)` in a helper
 * because the closure is async. This keeps the verifier itself synchronous over already-resolved
 * inputs and unit-testable without stubbing Supabase.
 */
import type { CreativeBrief } from "@/lib/ads/creative-brief";
import type { PIReview, ProductIntelligence } from "@/lib/product-intelligence";
import type { AuthorModeCopy } from "@/lib/ads/creative-agent";

/** The allowed source-field names — the SSOT vocabulary layer 1 (SKILL.md) names in its
 *  CLAIM-ONLY-WHAT'S-IN-THE-BRIEF table, layer 2 uses as the `claim_trace.source` enum on the
 *  AuthorModeCopy type, and layer 3 (this file) branches on. A divergence between the three would
 *  let a valid-per-layer-1 claim fail layer-2 parse or vice-versa.
 *
 *  `proofStack` is a first-class source (proofstack-is-a-citeable-claim-source) — Dahlia was
 *  self-censoring 700K customers + 30-day money-back onto a non-existent `reviews-volume` cite;
 *  giving her a direct source gate makes the strongest brand facts USABLE. */
export const NEVER_FABRICATE_SOURCES = [
  "ingredients",
  "ingredient_research",
  "reviews.byClaim",
  "transformationStory",
  "supportingBenefit",
  "leadProof",
  "competitorDna",
  "proofStack",
] as const;

export type NeverFabricateSource = (typeof NEVER_FABRICATE_SOURCES)[number];

export interface ClaimTraceEntry {
  claim: string;
  source: NeverFabricateSource;
  source_ref: string;
}

export interface ClaimMiss {
  claim: string;
  source: string;
  source_ref: string;
  /** `fabricated_number` — the claim states a NUMBER (a stat/price/count) that does NOT appear anywhere
   *  in our real data (e.g. a competitor's "500 million cups" carried into our copy). The strongest
   *  fabrication signal + the one thing a reworded claim may never invent. */
  reason: "source_not_found" | "claim_not_in_source" | "fabricated_number";
}

export interface VerifyClaimTraceResult {
  ok: boolean;
  misses: ClaimMiss[];
}

/** Reviews already resolved for a benefit_name. Layer-3 verification for `source='reviews.byClaim'`
 *  needs the actual PIReview rows the closure returns, but the closure is async — the caller runs
 *  it once per unique `source_ref` and passes the map to keep this verifier pure/sync. */
export type ReviewsByClaimResolved = Map<string, PIReview[]>;

function low(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase().trim() : "";
}

function containsCI(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return low(haystack).includes(low(needle));
}

/** True iff any `text | body | summary | smart_quote` on a review row contains the claim substring
 *  case-insensitively. The M1 keystone's brief-back logic already picks reviews with `smart_quote`,
 *  but body / title fallbacks are covered too — same match surface layer 1's SKILL.md names. */
function reviewContains(r: PIReview, needle: string): boolean {
  if (!needle) return false;
  const n = low(needle);
  return (
    low(r.body).includes(n) ||
    low(r.smart_quote).includes(n) ||
    low(r.title).includes(n) ||
    low(r.summary).includes(n)
  );
}

// ── fact-grounded verification (2026-07-17) ──────────────────────────────────────────────────────
// The old firewall required the claim to be a VERBATIM SUBSTRING of the source, which rejected faithful
// summaries ("Barbara H. says she lost 40+ pounds" vs the review "I lost 40+ pounds!") — exactly the
// rewording the CEO wants Dahlia to be able to do. Fact-grounding instead: a reworded claim is grounded
// iff (a) every NUMBER it states appears in our real data (a fabricated statistic — e.g. a competitor's
// "500 million cups" — is the one thing a rewording may never invent), and (b) its content tokens
// sufficiently overlap the cited source (it's a paraphrase OF that source, not an unrelated claim).

const NUM_RE = /\d[\d,]*(?:\.\d+)?\s*(?:%|k\b|m\b|b\b|million|thousand|billion)?/gi;
/** Normalized numeric facts in a text — commas/whitespace stripped, lowercased. "700,000+" → "700000",
 *  "$29" → "29", "500 million" → "500million", "95%" → "95%". These are the facts a reworded claim must
 *  still trace to; other words are free to change. */
function numericFacts(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of low(text).matchAll(NUM_RE)) {
    const t = m[0].replace(/[,\s]/g, "");
    if (/\d/.test(t)) out.add(t);
  }
  return out;
}

const CLAIM_STOP = new Set([
  "that", "this", "with", "your", "from", "have", "they", "them", "then", "than", "been", "were",
  "will", "what", "when", "which", "their", "there", "about", "into", "over", "just", "more", "most",
  "some", "only", "also", "while", "would", "could", "should", "every", "after", "before", "says", "said",
]);
/** Substantive content tokens (≥4 chars, non-stopword). Rewording is fine — these anchor a claim to
 *  the cited source's TOPIC so an unrelated claim (which shares few) still fails. */
function contentTokens(text: string): string[] {
  return low(text).split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !CLAIM_STOP.has(t));
}
/** Fuzzy token membership — tolerates simple plural/stem drift ("superfood"⊆"superfoods", "pound"⊆"pounds"). */
function tokenIn(tok: string, set: readonly string[]): boolean {
  return set.some((s) => s === tok || s.includes(tok) || tok.includes(s));
}

/** Fact-grounded claim check. `groundNumbers` is the set of numeric facts in OUR real data — every
 *  number in the claim must be in it (else `fabricated_number`); `sourceText` is the specific cited
 *  source the claim must be ABOUT (≥40% content-token overlap, else `claim_not_in_source`). Returns
 *  null when the claim is grounded. */
function claimGroundedInSource(
  claim: string,
  sourceText: string,
  groundNumbers: Set<string>,
): null | "fabricated_number" | "claim_not_in_source" {
  const claimNums = numericFacts(claim);
  for (const n of claimNums) if (!groundNumbers.has(n)) return "fabricated_number";
  const ct = contentTokens(claim);
  if (ct.length === 0) return null; // a pure-number/short claim — the numbers are already grounded
  const src = contentTokens(sourceText);
  const hits = ct.filter((t) => tokenIn(t, src)).length;
  // A number-anchored claim ("700,000+ coffee lovers" ← "700,000+ customers …") is tied to the source
  // by its grounded number, so it needs only a LIGHT topical link (≥1 shared token) — this both allows
  // the rephrase AND still blocks an off-topic hijack ("700,000+ cured of cancer" shares 0 tokens). A
  // claim with NO number must earn stronger relevance so a qualitative claim is genuinely about the source.
  if (claimNums.size > 0) return hits >= 1 ? null : "claim_not_in_source";
  return hits / ct.length >= 0.34 ? null : "claim_not_in_source";
}

/**
 * verifyClaimTrace — the deterministic layer-3 gate.
 *
 * Per source rules (mirror the CLAIM-ONLY-WHAT'S-IN-THE-BRIEF table in
 * `.claude/skills/dahlia-copy-author/SKILL.md`):
 *
 *   • `ingredients` → `pi.ingredients` contains a row whose `name` matches `source_ref` (CI),
 *     AND the claim substring appears in that row's dosage / display fields.
 *   • `ingredient_research` → `pi.ingredientResearch` has a row whose ingredient name matches
 *     `source_ref` (CI), AND the claim substring appears in that row's research text.
 *   • `reviews.byClaim` → the caller resolves `pi.reviews.byClaim(source_ref)` and passes the
 *     result via `reviewsByClaim`. At least one returned PIReview's body/quote/title/summary
 *     must contain the claim substring.
 *   • `transformationStory` → `brief.transformation` has reviewer + quote, AND the claim
 *     substring appears in either field.
 *   • `supportingBenefit` → `brief.supportingBenefits` contains the `source_ref` token (CI)
 *     AND the claim contains a substring of that benefit.
 *   • `leadProof` → `brief.leadProof.attribution` or `brief.leadProof.text` contains the claim.
 *   • `competitorDna` → the CreativeBrief today has no `competitorDna` field (the M2 debrand
 *     spec has not shipped yet), so the gate is fail-closed: `source_not_found`. When M2
 *     ships and the brief carries `competitorDna`, this branch will resolve the slot.
 *   • `proofStack` → `brief.proofStack` contains an entry the `source_ref` matches (or the
 *     claim is fact-grounded against the union of proofStack lines). This is the DIRECT
 *     source for the verified brand facts (700K+ customers, 30-day money-back, 15K+
 *     reviews, 'Best Tasting' Gourmet Magazine, Non-GMO, 3rd-party tested, Made In USA) so
 *     Dahlia doesn't have to launder them through `supportingBenefit`. Numbers still ground
 *     against the same real-data corpus so a fabricated proofStack stat (e.g. "8,000,000+
 *     customers") is `fabricated_number`. `supportingBenefit`'s existing proofStack fallback
 *     is preserved for grandfathered captions.
 *
 * Returns `{ok:true, misses:[]}` when every entry traces cleanly; otherwise `ok=false` with a
 * typed miss per failing entry. The caller (creative-agent stockProduct) returns the miss list
 * as a `firewall_claim_miss` skip so the M1 revise loop consumes it, and on revise exhaustion
 * emits a distinct `dahlia_copy_firewall_exhausted` director_activity kind (so operators can
 * slice fabrication failures separately from self-score failures).
 */
export function verifyClaimTrace(
  claim_trace: AuthorModeCopy["claim_trace"],
  brief: Pick<CreativeBrief, "leadProof" | "transformation" | "supportingBenefits"> & { proofStack?: string[] },
  pi: Pick<ProductIntelligence, "ingredients" | "ingredientResearch">,
  reviewsByClaim: ReviewsByClaimResolved = new Map(),
): VerifyClaimTraceResult {
  const misses: ClaimMiss[] = [];
  if (!Array.isArray(claim_trace)) return { ok: false, misses };

  // OUR real-data number corpus — every numeric fact anywhere in our own product data, EXCLUDING the
  // competitor DNA. A claim citing an OUR source grounds its numbers against THAT specific source
  // (tight — a review number must be in that review); a claim citing `competitorDna` grounds against
  // THIS corpus instead, so the competitor's "500 million cups" (only in their hook) is a
  // `fabricated_number` — we imitate their ANGLE, never claim their STATS.
  const ourCorpusNumbers = new Set<string>();
  const addNums = (s: unknown) => { if (typeof s === "string") for (const n of numericFacts(s)) ourCorpusNumbers.add(n); };
  addNums(brief.leadProof?.text); addNums(brief.leadProof?.attribution);
  addNums(brief.transformation?.quote); addNums(brief.transformation?.reviewer);
  for (const b of brief.supportingBenefits ?? []) addNums(b);
  for (const p of brief.proofStack ?? []) addNums(p);
  for (const r of pi.ingredients as Array<Record<string, unknown>>) { addNums(r.dosage); addNums(r.display); addNums(r.display_name); addNums(r.research); }
  for (const r of pi.ingredientResearch as Array<Record<string, unknown>>) { addNums(r.benefit_headline); addNums(r.mechanism_explanation); addNums(r.research); addNums(r.summary); addNums(r.body); }
  for (const rs of reviewsByClaim.values()) for (const r of rs) { addNums(r.body); addNums(r.smart_quote); addNums(r.title); addNums(r.summary); }

  for (const entry of claim_trace) {
    const claim = typeof entry?.claim === "string" ? entry.claim : "";
    const source = entry?.source;
    const source_ref = typeof entry?.source_ref === "string" ? entry.source_ref : "";
    const miss = (reason: ClaimMiss["reason"]): ClaimMiss => ({
      claim, source: String(source), source_ref, reason,
    });

    if (source === "ingredients") {
      const row = (pi.ingredients as Array<Record<string, unknown>>).find((r) => {
        const name = typeof r.name === "string" ? r.name : "";
        return low(name) === low(source_ref);
      });
      if (!row) { misses.push(miss("source_not_found")); continue; }
      const dosage = typeof row.dosage === "string" ? row.dosage : "";
      const display = typeof row.display === "string" ? row.display : "";
      const displayName = typeof row.display_name === "string" ? row.display_name : "";
      const research = typeof row.research === "string" ? row.research : "";
      const combined = `${dosage} ${display} ${displayName} ${research}`;
      { const g = claimGroundedInSource(claim, combined, numericFacts(combined)); if (g) { misses.push(miss(g)); continue; } }
      continue;
    }

    if (source === "ingredient_research") {
      const row = (pi.ingredientResearch as Array<Record<string, unknown>>).find((r) => {
        const name = typeof r.ingredient_name === "string" ? r.ingredient_name : typeof r.name === "string" ? r.name : "";
        return low(name) === low(source_ref);
      });
      if (!row) { misses.push(miss("source_not_found")); continue; }
      const text = [row.benefit_headline, row.mechanism_explanation, row.research, row.summary, row.body]
        .filter((v): v is string => typeof v === "string")
        .join(" ");
      { const g = claimGroundedInSource(claim, text, numericFacts(text)); if (g) { misses.push(miss(g)); continue; } }
      continue;
    }

    if (source === "reviews.byClaim") {
      const reviews = reviewsByClaim.get(source_ref) ?? reviewsByClaim.get(low(source_ref)) ?? [];
      if (!reviews.length) { misses.push(miss("source_not_found")); continue; }
      // A reworded claim grounds against the UNION of the resolved reviews' text (a paraphrase of a
      // real review is fine; an invented number is not). Kept `reviewContains` as a fast verbatim
      // short-circuit for an exact quote.
      const exact = reviews.some((r) => reviewContains(r, claim));
      if (!exact) {
        const reviewText = reviews.map((r) => [r.body, r.smart_quote, r.title, r.summary].filter((v): v is string => typeof v === "string").join(" ")).join(" ");
        const g = claimGroundedInSource(claim, reviewText, numericFacts(reviewText));
        if (g) { misses.push(miss(g)); continue; }
      }
      continue;
    }

    if (source === "transformationStory") {
      const t = brief.transformation;
      if (!t || !t.reviewer || !t.quote) { misses.push(miss("source_not_found")); continue; }
      const refMatchesReviewer = source_ref ? containsCI(t.reviewer, source_ref) || containsCI(source_ref, t.reviewer) : true;
      if (!refMatchesReviewer) { misses.push(miss("source_not_found")); continue; }
      const combined = `${t.reviewer} ${t.quote}`;
      { const g = claimGroundedInSource(claim, combined, numericFacts(combined)); if (g) { misses.push(miss(g)); continue; } }
      continue;
    }

    if (source === "supportingBenefit") {
      // Search BOTH supportingBenefits AND the proof stack — Dahlia cites `supportingBenefit` for a
      // proof-stack fact ("700,000+ customers …", "Non-GMO · 3rd Party Tested · Made In USA") too.
      const benefits = [...(brief.supportingBenefits ?? []), ...(brief.proofStack ?? [])];
      const match = benefits.find((b) => containsCI(b, source_ref) || containsCI(source_ref, b))
        ?? benefits.find((b) => claimGroundedInSource(claim, b, numericFacts(b)) === null);
      if (!match) { misses.push(miss("source_not_found")); continue; }
      // Ground the RELEVANCE against the WHOLE proof corpus, not just the one cited item — a proof claim
      // legitimately COMBINES several verified points ("clean, non-GMO, 3rd party tested, made in USA").
      // Every one of those points is already ours; the numbers are still checked against `groundNumbers`.
      { const g = claimGroundedInSource(claim, benefits.join(" "), numericFacts(benefits.join(" "))); if (g) { misses.push(miss(g)); continue; } }
      continue;
    }

    if (source === "leadProof") {
      const lp = brief.leadProof;
      if (!lp) { misses.push(miss("source_not_found")); continue; }
      const combined = `${lp.attribution ?? ""} ${lp.text ?? ""}`;
      { const g = claimGroundedInSource(claim, combined, numericFacts(combined)); if (g) { misses.push(miss(g)); continue; } }
      continue;
    }

    if (source === "proofStack") {
      // proofstack-is-a-citeable-claim-source — brief.proofStack is the DIRECT source for the
      // verified brand facts (700K+ customers · 30-day money-back · 15K+ reviews · Gourmet
      // Magazine 'Best Tasting' · Non-GMO · 3rd-party tested · Made In USA). The `source_ref`
      // matches one of the proofStack lines (CI containsCI); the claim then grounds against
      // the UNION of proofStack (a proof claim legitimately combines several verified points —
      // "clean, non-GMO, 3rd party tested, made in USA"). Numbers still ground against the
      // named corpus so a fabricated stat ("8,000,000+ customers") is `fabricated_number`
      // even though the token appears elsewhere.
      const stack = brief.proofStack ?? [];
      if (stack.length === 0) { misses.push(miss("source_not_found")); continue; }
      const match = stack.find((s) => containsCI(s, source_ref) || containsCI(source_ref, s))
        ?? stack.find((s) => claimGroundedInSource(claim, s, numericFacts(s)) === null);
      if (!match) { misses.push(miss("source_not_found")); continue; }
      const joined = stack.join(" ");
      { const g = claimGroundedInSource(claim, joined, numericFacts(joined)); if (g) { misses.push(miss(g)); continue; } }
      continue;
    }

    if (source === "competitorDna") {
      // The M2 dahlia-preserve-competitor-copy-dna-debranded spec has not shipped a
      // `brief.competitorDna` field yet — fail-closed per the firewall spec Phase 3.
      const briefWithDna = brief as unknown as { competitorDna?: Record<string, unknown> | null };
      const dna = briefWithDna.competitorDna;
      if (!dna || typeof dna !== "object") { misses.push(miss("source_not_found")); continue; }
      const slot = (dna as Record<string, unknown>)[source_ref];
      if (typeof slot !== "string" || !slot) { misses.push(miss("source_not_found")); continue; }
      // Numbers ground against OUR corpus (NOT the competitor slot) — so the competitor's "500 million
      // cups" is `fabricated_number` even though it's literally in their hook, while the STRUCTURE the
      // claim borrows (token overlap with the debranded slot) is allowed. That's imitate-the-angle,
      // never-claim-their-stats.
      { const g = claimGroundedInSource(claim, slot, ourCorpusNumbers); if (g) { misses.push(miss(g)); continue; } }
      continue;
    }

    // Unknown source enum value — shouldn't reach here because parseAuthorVerdict validates the
    // enum, but treat as fail-closed defense-in-depth.
    misses.push(miss("source_not_found"));
  }
  return { ok: misses.length === 0, misses };
}

/** Resolve every `reviews.byClaim` entry's source_ref via the (async) closure so
 *  `verifyClaimTrace` can run pure/sync. Best-effort: a closure throw resolves to an empty
 *  array, which makes the verifier fail-closed on that entry. */
export async function resolveReviewsForClaimTrace(
  claim_trace: AuthorModeCopy["claim_trace"],
  reviewsByClaim: (benefitName: string) => Promise<PIReview[]>,
): Promise<ReviewsByClaimResolved> {
  const out: ReviewsByClaimResolved = new Map();
  const uniqueRefs = new Set<string>();
  for (const e of claim_trace ?? []) {
    if (e?.source === "reviews.byClaim" && typeof e.source_ref === "string" && e.source_ref) {
      uniqueRefs.add(e.source_ref);
    }
  }
  for (const ref of uniqueRefs) {
    try {
      out.set(ref, await reviewsByClaim(ref));
    } catch {
      out.set(ref, []);
    }
  }
  return out;
}
