/**
 * Unit tests for the dahlia-never-fabricate-copy-firewall Phase 3 verifier.
 *
 * Pins the deterministic layer-3 gate against the fully-backed CreativeBrief +
 * ProductIntelligence surface for the exact fabrication classes the spec calls out.
 *
 * Runs via: npm run test:never-fabricate
 *   ↳ tsx --test src/lib/ads/never-fabricate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { verifyClaimTrace, type ClaimTraceEntry, type ReviewsByClaimResolved } from "./never-fabricate";
import type { CreativeBrief } from "@/lib/ads/creative-brief";
import type { ProductIntelligence, PIReview } from "@/lib/product-intelligence";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

function brief(overrides: Partial<CreativeBrief> = {}): Pick<CreativeBrief, "leadProof" | "transformation" | "supportingBenefits"> {
  return {
    leadProof: { kind: "review", text: "changed my life", attribution: "Sarah H." },
    transformation: { reviewer: "Kaitlyn", quote: "I lost 40 lbs in 12 weeks", beforeAfterImage: null },
    supportingBenefits: ["steady focus", "no jitters", "no crash"],
    ...overrides,
  };
}

function pi(overrides: Partial<Pick<ProductIntelligence, "ingredients" | "ingredientResearch">> = {}): Pick<ProductIntelligence, "ingredients" | "ingredientResearch"> {
  return {
    ingredients: [
      { name: "L-theanine", dosage: "600mg L-theanine", display: "L-theanine 600mg per serving" },
      { name: "Ashwagandha", dosage: "300mg KSM-66 ashwagandha", display: "KSM-66 ashwagandha 300mg" },
    ],
    ingredientResearch: [
      {
        ingredient_name: "L-theanine",
        benefit_headline: "supports calm focus",
        mechanism_explanation: "L-theanine crosses the blood-brain barrier and modulates alpha waves",
      },
    ],
    ...overrides,
  };
}

function reviewsMap(entries: Record<string, PIReview[]>): ReviewsByClaimResolved {
  const m: ReviewsByClaimResolved = new Map();
  for (const [k, v] of Object.entries(entries)) m.set(k, v);
  return m;
}

function review(overrides: Partial<PIReview> = {}): PIReview {
  return {
    id: "r-1",
    reviewer_name: "Anon",
    rating: 5,
    title: null,
    body: null,
    summary: null,
    smart_quote: null,
    verified_purchase: true,
    featured: false,
    images: [],
    cancel_relevance: null,
    published_at: null,
    ...overrides,
  };
}

// ── (a) every claim traces cleanly → ok:true, misses empty ─────────────────────────────────────

test("(a) every claim traces cleanly across all seven sources → ok:true, misses empty", () => {
  const trace: ClaimTraceEntry[] = [
    { claim: "600mg L-theanine", source: "ingredients", source_ref: "L-theanine" },
    { claim: "modulates alpha waves", source: "ingredient_research", source_ref: "L-theanine" },
    { claim: "40 lbs", source: "reviews.byClaim", source_ref: "weight loss" },
    { claim: "I lost 40 lbs in 12 weeks", source: "transformationStory", source_ref: "Kaitlyn" },
    { claim: "steady focus", source: "supportingBenefit", source_ref: "steady focus" },
    { claim: "changed my life", source: "leadProof", source_ref: "Sarah H." },
  ];
  const resolved = reviewsMap({
    "weight loss": [review({ body: "I lost 40 lbs and feel amazing", reviewer_name: "Kaitlyn" })],
  });
  const result = verifyClaimTrace(trace, brief(), pi(), resolved);
  assert.equal(result.ok, true);
  assert.equal(result.misses.length, 0);
});

// ── (b) reviews.byClaim: a bare number '40 lbs' whose returned reviews DON'T contain '40 lbs'
//      → ok:false with claim_not_in_source ─────────────────────────────────────────────────────

test("(b) reviews.byClaim '40 lbs' but returned reviews don't contain the number 40 → fabricated_number", () => {
  const trace: ClaimTraceEntry[] = [
    { claim: "40 lbs", source: "reviews.byClaim", source_ref: "weight loss" },
  ];
  const resolved = reviewsMap({
    // The closure returned reviews, but NONE of them literally contain "40 lbs".
    "weight loss": [
      review({ body: "I feel amazing and have more energy", reviewer_name: "Amy" }),
      review({ smart_quote: "changed my morning routine", reviewer_name: "Bea" }),
    ],
  });
  const result = verifyClaimTrace(trace, brief(), pi(), resolved);
  assert.equal(result.ok, false);
  assert.equal(result.misses.length, 1);
  assert.equal(result.misses[0].reason, "fabricated_number");
  assert.equal(result.misses[0].source, "reviews.byClaim");
  assert.equal(result.misses[0].claim, "40 lbs");
});

// ── fact-grounded: a faithful PARAPHRASE of our real data passes; a fabricated number / off-topic
//    claim / competitor stat is blocked (CEO 2026-07-17) ──────────────────────────────────────────
function factBrief() {
  return {
    leadProof: { kind: "review" as const, text: "I lost 40+ pounds!", attribution: "Barbara H." },
    transformation: null,
    supportingBenefits: ["steady all-day energy"],
    proofStack: ["700,000+ customers across the country trust Superfoods Company", "Non-GMO", "3rd Party Tested", "Made In The USA"],
    competitorDna: { hook: "500+ million cups of coffee sold" },
  } as unknown as Parameters<typeof verifyClaimTrace>[1];
}
const emptyPi = { ingredients: [], ingredientResearch: [] } as unknown as Parameters<typeof verifyClaimTrace>[2];

test("fact-grounded: a faithful review paraphrase passes ('Barbara says she lost 40+ pounds')", () => {
  const r = verifyClaimTrace([{ claim: "Barbara H. says she lost 40+ pounds", source: "leadProof", source_ref: "Barbara H." }], factBrief(), emptyPi);
  assert.equal(r.ok, true);
});

test("fact-grounded: a reworded proof-stat with OUR number passes ('700,000+ who reach for their superfood coffee')", () => {
  const r = verifyClaimTrace([{ claim: "700,000+ who reach for their superfood coffee", source: "supportingBenefit", source_ref: "700,000+ customers across the country trust Superfoods Company" }], factBrief(), emptyPi);
  assert.equal(r.ok, true);
});

test("fact-grounded: a combined proof claim passes ('clean, non-GMO, 3rd party tested, made in USA')", () => {
  const r = verifyClaimTrace([{ claim: "clean, non-GMO, 3rd party tested, and made in the USA", source: "supportingBenefit", source_ref: "Non-GMO" }], factBrief(), emptyPi);
  assert.equal(r.ok, true);
});

test("fact-grounded: a COMPETITOR'S number is fabricated_number ('500 million cups')", () => {
  const r = verifyClaimTrace([{ claim: "500 million cups keep getting poured", source: "competitorDna", source_ref: "hook" }], factBrief(), emptyPi);
  assert.equal(r.ok, false);
  assert.equal(r.misses[0].reason, "fabricated_number");
});

test("fact-grounded: an off-topic claim on a real number is blocked ('700,000+ cured of cancer')", () => {
  const r = verifyClaimTrace([{ claim: "700,000+ cured of cancer", source: "supportingBenefit", source_ref: "700,000+ customers across the country trust Superfoods Company" }], factBrief(), emptyPi);
  assert.equal(r.ok, false);
  assert.equal(r.misses[0].reason, "claim_not_in_source");
});

test("fact-grounded: a fabricated stat is blocked ('clinically proven 90% more focus')", () => {
  const r = verifyClaimTrace([{ claim: "clinically proven 90% more focus", source: "supportingBenefit", source_ref: "steady all-day energy" }], factBrief(), emptyPi);
  assert.equal(r.ok, false);
  assert.equal(r.misses[0].reason, "fabricated_number");
});

// ── (c) ingredients with source_ref='L-theanine' when pi.ingredients carries only ashwagandha
//      → ok:false with source_not_found ─────────────────────────────────────────────────────────

test("(c) ingredients source_ref='L-theanine' but pi.ingredients only carries ashwagandha → source_not_found", () => {
  const trace: ClaimTraceEntry[] = [
    { claim: "600mg L-theanine", source: "ingredients", source_ref: "L-theanine" },
  ];
  const ashwagandhaOnly = pi({
    ingredients: [{ name: "Ashwagandha", dosage: "300mg", display: "KSM-66 ashwagandha 300mg" }],
    ingredientResearch: [],
  });
  const result = verifyClaimTrace(trace, brief(), ashwagandhaOnly);
  assert.equal(result.ok, false);
  assert.equal(result.misses.length, 1);
  assert.equal(result.misses[0].reason, "source_not_found");
  assert.equal(result.misses[0].source, "ingredients");
});

// ── (d) transformationStory with reviewer name MISMATCH → ok:false with source_not_found ──────

test("(d) transformationStory with reviewer mismatch → source_not_found", () => {
  const trace: ClaimTraceEntry[] = [
    { claim: "lost 40 lbs", source: "transformationStory", source_ref: "SomeoneElse" },
  ];
  // brief.transformation.reviewer is 'Kaitlyn' — the trace cites a different reviewer.
  const result = verifyClaimTrace(trace, brief(), pi());
  assert.equal(result.ok, false);
  assert.equal(result.misses.length, 1);
  assert.equal(result.misses[0].reason, "source_not_found");
  assert.equal(result.misses[0].source, "transformationStory");
});

// ── (e) competitorDna cited when brief.competitorDna is ABSENT → ok:false, source_not_found ───

test("(e) competitorDna cited but brief has no competitorDna (M2 spec not shipped) → source_not_found", () => {
  const trace: ClaimTraceEntry[] = [
    { claim: "10x collagen bond", source: "competitorDna", source_ref: "mechanism" },
  ];
  // brief() does not carry competitorDna — the M2 debrand spec has not shipped, so this
  // must fail-closed per the firewall Phase 3 rule.
  const result = verifyClaimTrace(trace, brief(), pi());
  assert.equal(result.ok, false);
  assert.equal(result.misses.length, 1);
  assert.equal(result.misses[0].reason, "source_not_found");
  assert.equal(result.misses[0].source, "competitorDna");
});

// ── Extra pin: mixed trace with a mix of pass + fail → ok:false, misses covers ONLY the failing
//    entries (the ok entries do not surface in misses) ───────────────────────────────────────────

test("mixed trace: passing + failing entries → ok:false, misses covers only failing entries", () => {
  const trace: ClaimTraceEntry[] = [
    { claim: "600mg L-theanine", source: "ingredients", source_ref: "L-theanine" }, // OK
    { claim: "40 lbs", source: "reviews.byClaim", source_ref: "weight loss" }, // FAIL
    { claim: "steady focus", source: "supportingBenefit", source_ref: "steady focus" }, // OK
  ];
  const resolved = reviewsMap({ "weight loss": [review({ body: "great energy" })] });
  const result = verifyClaimTrace(trace, brief(), pi(), resolved);
  assert.equal(result.ok, false);
  assert.equal(result.misses.length, 1);
  assert.equal(result.misses[0].claim, "40 lbs");
});

test("non-array claim_trace → ok:false (defense-in-depth for a mis-shaped parse)", () => {
  const result = verifyClaimTrace(null as unknown as ClaimTraceEntry[], brief(), pi());
  assert.equal(result.ok, false);
  assert.equal(result.misses.length, 0);
});

test("reviews.byClaim source_ref with no resolved reviews → source_not_found", () => {
  const trace: ClaimTraceEntry[] = [
    { claim: "x", source: "reviews.byClaim", source_ref: "unresolved" },
  ];
  const result = verifyClaimTrace(trace, brief(), pi(), new Map());
  assert.equal(result.ok, false);
  assert.equal(result.misses[0].reason, "source_not_found");
});
