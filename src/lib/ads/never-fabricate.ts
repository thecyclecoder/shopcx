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

/** The seven allowed source-field names — the SSOT vocabulary layer 1 (SKILL.md) names in its
 *  CLAIM-ONLY-WHAT'S-IN-THE-BRIEF table, layer 2 uses as the `claim_trace.source` enum on the
 *  AuthorModeCopy type, and layer 3 (this file) branches on. A divergence between the three would
 *  let a valid-per-layer-1 claim fail layer-2 parse or vice-versa. */
export const NEVER_FABRICATE_SOURCES = [
  "ingredients",
  "ingredient_research",
  "reviews.byClaim",
  "transformationStory",
  "supportingBenefit",
  "leadProof",
  "competitorDna",
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
  reason: "source_not_found" | "claim_not_in_source";
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
 *
 * Returns `{ok:true, misses:[]}` when every entry traces cleanly; otherwise `ok=false` with a
 * typed miss per failing entry. The caller (creative-agent stockProduct) returns the miss list
 * as a `firewall_claim_miss` skip so the M1 revise loop consumes it, and on revise exhaustion
 * emits a distinct `dahlia_copy_firewall_exhausted` director_activity kind (so operators can
 * slice fabrication failures separately from self-score failures).
 */
export function verifyClaimTrace(
  claim_trace: AuthorModeCopy["claim_trace"],
  brief: Pick<CreativeBrief, "leadProof" | "transformation" | "supportingBenefits">,
  pi: Pick<ProductIntelligence, "ingredients" | "ingredientResearch">,
  reviewsByClaim: ReviewsByClaimResolved = new Map(),
): VerifyClaimTraceResult {
  const misses: ClaimMiss[] = [];
  if (!Array.isArray(claim_trace)) return { ok: false, misses };
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
      if (!containsCI(combined, claim)) { misses.push(miss("claim_not_in_source")); continue; }
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
      if (!containsCI(text, claim)) { misses.push(miss("claim_not_in_source")); continue; }
      continue;
    }

    if (source === "reviews.byClaim") {
      const reviews = reviewsByClaim.get(source_ref) ?? reviewsByClaim.get(low(source_ref)) ?? [];
      if (!reviews.length) { misses.push(miss("source_not_found")); continue; }
      const hit = reviews.some((r) => reviewContains(r, claim));
      if (!hit) { misses.push(miss("claim_not_in_source")); continue; }
      continue;
    }

    if (source === "transformationStory") {
      const t = brief.transformation;
      if (!t || !t.reviewer || !t.quote) { misses.push(miss("source_not_found")); continue; }
      const refMatchesReviewer = source_ref ? containsCI(t.reviewer, source_ref) || containsCI(source_ref, t.reviewer) : true;
      if (!refMatchesReviewer) { misses.push(miss("source_not_found")); continue; }
      const combined = `${t.reviewer} ${t.quote}`;
      if (!containsCI(combined, claim)) { misses.push(miss("claim_not_in_source")); continue; }
      continue;
    }

    if (source === "supportingBenefit") {
      const benefits = brief.supportingBenefits ?? [];
      const match = benefits.find((b) => containsCI(b, source_ref) || containsCI(source_ref, b));
      if (!match) { misses.push(miss("source_not_found")); continue; }
      if (!containsCI(match, claim) && !containsCI(claim, match)) { misses.push(miss("claim_not_in_source")); continue; }
      continue;
    }

    if (source === "leadProof") {
      const lp = brief.leadProof;
      if (!lp) { misses.push(miss("source_not_found")); continue; }
      const combined = `${lp.attribution ?? ""} ${lp.text ?? ""}`;
      if (!containsCI(combined, claim)) { misses.push(miss("claim_not_in_source")); continue; }
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
      if (!containsCI(slot, claim)) { misses.push(miss("claim_not_in_source")); continue; }
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
