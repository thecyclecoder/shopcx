/**
 * decision-engine tests — pins that substituteIntoSkeleton honors the temperature-keyed
 * substitution rule, sources warm/hot offers from productIntelligence VERBATIM (never
 * invents), and computes the four guardrail axes Max's substitution supervisor rubric
 * (Phase 2) grades against.
 *
 * Runs via: npx tsx --test src/lib/ads/decision-engine.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  substituteIntoSkeleton,
  SUBSTITUTION_RULES,
  type SkeletonForDecision,
  type SkeletonElement,
  type DecisionEngineIntelligence,
} from "./decision-engine";
import type { ProductAngle } from "./angle-palette";
import type { HeadlinePattern, AwarenessStage } from "./headline-patterns";
import type { ProductOffer } from "@/lib/product-intelligence";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeAngle(over: Partial<ProductAngle> = {}): ProductAngle {
  return {
    id: "angle-1",
    productId: "prod-1",
    theme: "energy_performance",
    problem: "afternoon energy crash",
    ingredients: ["cordyceps"],
    benefitKey: "clean_energy",
    enemy: "the 3pm slump",
    mechanism: "cordyceps ATP support",
    desiredOutcome: "steady focus all afternoon",
    proofText: "137,000 five-star reviews",
    proofKind: "customer",
    evidenceTier: "customer_only",
    backingReviewIds: [],
    searchDemand: "medium",
    awarenessStages: ["cold", "warm", "hot"],
    source: "seeded",
    timesUsed: 0,
    lastUsedAt: null,
    status: "fresh",
    isActive: true,
    displayOrder: 0,
    notes: null,
    ...over,
  } satisfies ProductAngle;
}

function makePattern(over: Partial<HeadlinePattern> = {}): HeadlinePattern {
  return {
    id: "pattern-1",
    slug: "problem-mechanism",
    name: "Problem → Mechanism",
    structure: "[PROBLEM] — [MECHANISM]",
    awarenessStages: ["cold", "warm", "hot"],
    consumes: ["enemy", "mechanism"],
    example: null,
    isActive: true,
    displayOrder: 0,
    ...over,
  } satisfies HeadlinePattern;
}

function makeOffer(over: Partial<ProductOffer> = {}): ProductOffer {
  return {
    subscribeDiscountPct: 25,
    freeShipping: true,
    quantityBreaks: [],
    maxCompoundDiscountPct: 34,
    headline: "Up to 34% off + free shipping (25% Subscribe & Save + up to 12% for 3+ units)",
    msrpCents: 4500,
    discountedUnitCents: 2970,
    servingsPerUnit: 30,
    perServingCents: 99,
    disclaimer: "with 3+ units on Subscribe & Save",
    ...over,
  } satisfies ProductOffer;
}

function makeSkeleton(over: Partial<SkeletonForDecision> = {}): SkeletonForDecision {
  return {
    elements: [],
    raw: [],
    advertiser: null,
    ...over,
  } satisfies SkeletonForDecision;
}

function el(role: SkeletonElement["role"], zone: SkeletonElement["zone"], prominence: number): SkeletonElement {
  return { role, zone, prominence };
}

// ── (i) cold + offer role → stripped + substituted with risk-reversal ─────────

test("cold + offer element strips promo and substitutes a risk-reversal (no price string)", () => {
  const result = substituteIntoSkeleton(
    {
      angle: makeAngle(),
      pattern: makePattern({ awarenessStages: ["cold"] }),
      temperature: "cold" as AwarenessStage,
      skeleton: makeSkeleton({ elements: [el("offer", "footer", 0.9)] }),
    },
    { productIntelligence: { offer: makeOffer() } satisfies DecisionEngineIntelligence },
  );

  const offerEl = result.substitutedElements[0];
  assert.equal(offerEl.role, "offer");
  assert.equal(offerEl.source, "angle_derived_risk_reversal");
  // The substitute must NOT carry any of the offer's price/percent/discount tokens.
  const t = (offerEl.substitutedText ?? "").toLowerCase();
  assert.ok(!/\d+%|\$|off|save|shipping|subscribe/.test(t), `cold substitute leaked price/promo string: ${t}`);
  // The reuse-verdict helper must have returned 'strip' for a cold offer element.
  assert.equal(offerEl.reuseVerdict, "strip");
  assert.equal(result.guardrails.honestFill, true);
});

// ── (ii) warm + offer → filled with productIntelligence.offer VERBATIM ────────

test("warm + offer element fills from productIntelligence.offer.headline byte-for-byte", () => {
  const offer = makeOffer();
  const result = substituteIntoSkeleton(
    {
      angle: makeAngle(),
      pattern: makePattern({ awarenessStages: ["warm"] }),
      temperature: "warm" as AwarenessStage,
      skeleton: makeSkeleton({ elements: [el("offer", "cta", 0.8)] }),
    },
    { productIntelligence: { offer } },
  );

  const offerEl = result.substitutedElements[0];
  assert.equal(offerEl.source, "product_intelligence.offer");
  // Byte-for-byte: the substituted text is === offer.headline.
  assert.equal(offerEl.substitutedText, offer.headline);
  assert.equal(result.guardrails.honestFill, true);
});

// ── (iii) warm + offer + null PI.offer → honestFill=false, no fabrication ─────

test("warm + offer with null productIntelligence.offer flunks honestFill and never invents", () => {
  const result = substituteIntoSkeleton(
    {
      angle: makeAngle(),
      pattern: makePattern({ awarenessStages: ["warm"] }),
      temperature: "warm" as AwarenessStage,
      skeleton: makeSkeleton({ elements: [el("offer", "cta", 0.8)] }),
    },
    { productIntelligence: { offer: null } },
  );

  const offerEl = result.substitutedElements[0];
  assert.equal(offerEl.source, "product_intelligence.offer");
  assert.equal(offerEl.substitutedText, null, "engine must NOT fabricate an offer string");
  assert.equal(result.guardrails.honestFill, false);
});

// ── (iv) noLeak fails when the substitute contains the competitor advertiser name ─

test("noLeak flunks when a substituted string contains the competitor's advertiser name", () => {
  // Angle proofText carries the competitor's brand name — the engine must detect the leak.
  const angle = makeAngle({
    // desiredOutcome referenced by 'body'-role substitutions, contains 'RivalBrand'.
    desiredOutcome: "outperforms RivalBrand in every clinical study",
    proofText: "outperforms RivalBrand in every clinical study",
  });
  const skeleton = makeSkeleton({
    elements: [el("proof", "body", 0.6)],
    advertiser: "RivalBrand",
  });
  const result = substituteIntoSkeleton(
    { angle, pattern: makePattern(), temperature: "warm" as AwarenessStage, skeleton },
    { productIntelligence: { offer: makeOffer() } },
  );

  assert.equal(result.guardrails.noLeak, false);
});

// ── (v) onStrategy fails when no substitute references angle.problem or .mechanism ─

test("onStrategy flunks when no substituted string references angle.problem or angle.mechanism", () => {
  // A hero-only element that fills from 'social_proof' role (proofText → 'excellent service'),
  // an angle whose problem + mechanism appear nowhere in the substitute.
  const angle = makeAngle({
    problem: "digestive bloating",
    mechanism: "prebiotic fiber blend",
    proofText: "excellent service and fast delivery",
    desiredOutcome: "excellent service and fast delivery",
    enemy: null,
  });
  const skeleton = makeSkeleton({
    elements: [el("social_proof", "footer", 0.4)],
  });
  const result = substituteIntoSkeleton(
    { angle, pattern: makePattern(), temperature: "warm" as AwarenessStage, skeleton },
    { productIntelligence: { offer: makeOffer() } },
  );

  assert.equal(result.guardrails.onStrategy, false);
});

// ── Rules table sanity: warm+offer rule exists as a named row ────────────────

test("SUBSTITUTION_RULES exports the temperature × role rows the M4 audit reads", () => {
  const warmOffer = SUBSTITUTION_RULES.find((r) => r.temperature === "warm" && r.role === "offer");
  assert.ok(warmOffer, "SUBSTITUTION_RULES must carry a warm+offer row");
  assert.equal(warmOffer!.source, "product_intelligence.offer");
  const coldOffer = SUBSTITUTION_RULES.find((r) => r.temperature === "cold" && r.role === "offer");
  assert.ok(coldOffer, "SUBSTITUTION_RULES must carry a cold+offer row");
  assert.equal(coldOffer!.source, "angle_derived_risk_reversal");
});

// ── Stateless: null skeleton → empty substituted set + vacuously-clean guardrails ─

test("null skeleton returns empty substitutedElements and passes the vacuous guardrails", () => {
  const result = substituteIntoSkeleton(
    {
      angle: makeAngle(),
      pattern: makePattern(),
      temperature: "warm" as AwarenessStage,
      skeleton: null,
    },
    { productIntelligence: { offer: makeOffer() } },
  );
  assert.equal(result.substitutedElements.length, 0);
  assert.equal(result.guardrails.noEmptySlot, true);
  assert.equal(result.guardrails.honestFill, true);
  assert.equal(result.guardrails.noLeak, true);
  // onStrategy is a .some() — with no elements it's vacuously false, which is honest
  // (there's no substitute to be on-strategy). Assert that so future readers see it.
  assert.equal(result.guardrails.onStrategy, false);
});
