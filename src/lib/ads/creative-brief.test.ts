/**
 * creative-brief tests — pins the LF8 guardrail on `buildMetaCopy` so a live test creative can
 * NEVER be published without at least one Life-Force-8 term when the brief carries an
 * LF8-adjacent supporting benefit ([[../ads-supervisor]] `live_ad_lf8_thin` gate). Also pins
 * the no-fake-injection escape hatch — when the brief truly has nothing LF8-adjacent, the copy
 * is left as-is (the supervisor re-flags on the next pass; we never fabricate a benefit).
 *   npx tsx --test src/lib/ads/creative-brief.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildCreativeBrief, buildMetaCopy, sanitizeCompetitorHook, selectAngles, type CreativeBrief, type ScoredAngle } from "./creative-brief";
import type { ProductIntelligence, PIReview } from "@/lib/product-intelligence";
import { hasAnyLf8 } from "./lf8";

function makePi(overrides: Partial<ProductIntelligence> = {}): ProductIntelligence {
  return {
    product: null,
    benefits: [],
    ingredients: [],
    ingredientResearch: [],
    adAngles: [],
    pageContent: null,
    reviewAnalysis: null,
    reviews: {
      totalCount: 0,
      fiveStarCount: 0,
      featured: [],
      recentFiveStar: [],
      withPhotos: [],
      byClaim: async () => [] as PIReview[],
    },
    media: { all: [], byCategory: {}, bySlotPrefix: () => [], isolatedPackshots: [] },
    blogPosts: [],
    seoKeywords: [],
    store: { brandProofPoints: [] },
    offer: null,
    variants: [],
    gaps: [],
    ...overrides,
  };
}

function makeAngle(overrides: Partial<ScoredAngle> = {}): ScoredAngle {
  return {
    hook: "Appetite suppression / craving control",
    source: "competitor",
    leadBenefit: "proven competitor angle",
    acquisitionPower: 9,
    retentionTruth: 5,
    commodity: false,
    hasRealPhoto: false,
    reasons: [],
    ...overrides,
  };
}

function makeBrief(overrides: Partial<CreativeBrief> = {}): CreativeBrief {
  return {
    productTitle: "Amazing Coffee",
    angle: makeAngle(),
    leadProof: null,
    transformation: null,
    supportingBenefits: [],
    proofStack: [],
    offer: { headline: "up to 34% off + free shipping", strikethrough: null, perServing: null, disclaimer: "" },
    imageRefs: [],
    guardrails: [],
    ...overrides,
  };
}

test("buildMetaCopy — LF8-carrying supporting benefit is promoted to the headline for a competitor angle", () => {
  const brief = makeBrief({
    supportingBenefits: ["appetite suppression", "steady energy — no crash", "great flavor"],
  });
  const copy = buildMetaCopy(brief);
  // The LF8 term ("energy" / "crash") is present in the headline (promoted over the non-LF8
  // "appetite suppression" that would win under the pre-fix "first non-empty" rule).
  assert.ok(hasAnyLf8(copy.headline.toLowerCase()), `headline "${copy.headline}" carries no LF8 term`);
});

test("buildMetaCopy — headline + primary text together always carry LF8 when the brief has an LF8-adjacent benefit", () => {
  const brief = makeBrief({
    supportingBenefits: ["appetite suppression", "craving control", "clean morning boost"],
  });
  const copy = buildMetaCopy(brief);
  assert.ok(
    hasAnyLf8(`${copy.headline} ${copy.primaryText}`.toLowerCase()),
    `composed copy carries no LF8 term:\nheadline: ${copy.headline}\nprimary: ${copy.primaryText}`,
  );
});

test("buildMetaCopy — never fabricates an LF8 term when the brief carries no LF8-adjacent language", () => {
  // Every supporting benefit and offer here is intentionally LF8-thin AND the product title is LF8-neutral
  // ("Zephyr Blend" — no LF8 substring). The pass must NOT invent an LF8 word (that would just paper over
  // a real product-intelligence gap). ads-supervisor is still expected to re-flag on the next pass — the
  // human-facing path for this state.
  // Angle overridden away from the "appetite suppression / craving control" default because those tokens
  // ARE LF8 under the broadened vocabulary (weight-loss cluster). The hook here uses purely product-spec
  // language that carries no LF8 term.
  const brief = makeBrief({
    productTitle: "Zephyr Blend",
    angle: makeAngle({ hook: "Single-origin arabica", leadBenefit: "single-origin arabica" }),
    supportingBenefits: ["single-origin arabica", "medium roast"],
    offer: { headline: "12 oz bag", strikethrough: null, perServing: null, disclaimer: "" },
  });
  const copy = buildMetaCopy(brief);
  // No LF8 present anywhere — the guardrail correctly declined to fabricate.
  assert.ok(
    !hasAnyLf8(`${copy.headline} ${copy.primaryText}`.toLowerCase()),
    `expected no LF8; got headline="${copy.headline}" primary="${copy.primaryText}"`,
  );
});

test("sanitizeCompetitorHook — strips a percent-off claim baked into the competitor's hook", () => {
  // The 2026-07-14 Amazing Creamer bin draft: hook "50% OFF" leaked from the competitor's ad
  // into our headline while our real offer said "up to 34% off" — the contradiction Phase 1 kills.
  assert.equal(sanitizeCompetitorHook("MUD\\WTR Mushroom Tea Blend — 50% OFF"), "MUD\\WTR Mushroom Tea Blend");
  assert.equal(sanitizeCompetitorHook("Up to 43% Off Today"), "Today");
  assert.equal(sanitizeCompetitorHook("Save 40% on your first bag"), "on your first bag");
  assert.equal(sanitizeCompetitorHook("Free Shipping · Best Coffee"), "Best Coffee");
  assert.equal(sanitizeCompetitorHook("BOGO — start your morning right"), "start your morning right");
  assert.equal(sanitizeCompetitorHook("2 for $30 today only"), "today only");
  // Own-brand-style hooks (no promotional token) are untouched.
  assert.equal(sanitizeCompetitorHook("Unlock steady morning energy"), "Unlock steady morning energy");
});

test("buildMetaCopy — a competitor hook's '50% OFF' never leaks into headline or primary text (only our offer is shown)", () => {
  // Simulate what buildCreativeBrief now does for a competitor angle: sanitize the hook before it
  // becomes brief.angle.hook. Every downstream consumer (buildMetaCopy here, buildPrompt in
  // creative-generate, expectedCopy for QA) reads from that single sanitized source.
  const rawHook = "The Coffee 50% OFF — appetite control today";
  const brief = makeBrief({
    angle: makeAngle({ hook: sanitizeCompetitorHook(rawHook), leadBenefit: "appetite control" }),
    supportingBenefits: ["appetite control", "steady energy — no crash"],
    // Our REAL offer — the only discount that may surface on the ad.
    offer: { headline: "Up to 34% off + free shipping", strikethrough: null, perServing: null, disclaimer: "" },
  });
  const copy = buildMetaCopy(brief);
  const composed = `${copy.headline} ${copy.primaryText}`;
  // The competitor's promotional number is gone from every field.
  assert.ok(!/50\s*%/i.test(composed), `50% leaked into copy — headline="${copy.headline}" primary="${copy.primaryText}"`);
  // The offer text (which carries "34%") only appears via the caption's offer/CTA line, sourced from
  // brief.offer — the legitimate path. Sanity: our real offer's percentage IS present somewhere.
  assert.ok(/34\s*%/i.test(composed), `expected our real offer's 34% to still surface via brief.offer`);
});

test("buildMetaCopy — own-brand angle keeps its raw hook when the hook itself carries LF8 language", () => {
  const brief = makeBrief({
    angle: makeAngle({ source: "review_cluster", hook: "Unlock steady morning energy", leadBenefit: "energy" }),
    supportingBenefits: ["great taste"],
  });
  const copy = buildMetaCopy(brief);
  // Own-brand angle → the hook drives the headline (not benefitHeadline). Verify LF8 is retained.
  assert.match(copy.headline.toLowerCase(), /unlock|energy|morning/);
  assert.ok(hasAnyLf8(copy.headline.toLowerCase()));
});

// ── selectAngles: curated lead-benefit seed ────────────────────────────────────
// dahlia-hooks-riff-competitor-angle-and-weave-in-lead-benefit Phase 1 — the curated
// `product_benefit_selections` role='lead' benefit must be present as a TOP-RANKED
// acquisition angle so the differentiated hook is on the table before ranking / imitation.
// Without this seed the Amazing Coffee cold creative led its headline with a purely borrowed
// commodity hook ("no jitters") — the fix is a root-level seed, not a scoring tweak.

test("selectAngles — seeds a top-priority angle from pi.benefits role='lead'", () => {
  const pi = makePi({
    benefits: [
      {
        benefit_name: "Weight loss",
        role: "lead",
        customer_phrases: ["Lost 15 lbs in three weeks", "curbs my appetite"],
        science_confirmed: true,
        customer_confirmed: true,
        display_order: 0,
      },
      {
        benefit_name: "No jitters",
        role: "supporting",
        customer_phrases: ["no crash", "steady energy"],
        display_order: 1,
      },
    ],
  });
  const ranked = selectAngles(pi);
  assert.ok(ranked.length > 0, "expected at least one seeded angle");
  const seeded = ranked.find((a) => a.source === "benefit" && a.leadBenefit === "Weight loss");
  assert.ok(seeded, `expected a source='benefit' angle for the lead benefit — got ${JSON.stringify(ranked.map((a) => ({ source: a.source, leadBenefit: a.leadBenefit })))}`);
  // Ranks at the top of the pool — the strongest differentiated angle before imitation.
  assert.equal(ranked[0].source, "benefit", `lead-benefit seed should lead the pool; got ${ranked[0].source}`);
  assert.equal(ranked[0].leadBenefit, "Weight loss");
  // Top-tier acquisition power + not commodity by construction.
  assert.equal(seeded.acquisitionPower, 10);
  assert.equal(seeded.commodity, false);
  // A punchy customer_phrase becomes the hook so the seeded angle carries real proof-language.
  assert.equal(seeded.hook, "Lost 15 lbs in three weeks");
  // The reason string names the source of the curation so downstream logs can trace it.
  assert.ok(
    seeded.reasons.some((r) => /curated lead benefit/i.test(r)),
    `expected a 'curated lead benefit' reason; got ${JSON.stringify(seeded.reasons)}`,
  );
});

test("selectAngles — no role='lead' row degrades gracefully to today's behavior (no benefit-source angle)", () => {
  const pi = makePi({
    benefits: [
      { benefit_name: "Great taste", role: "supporting", customer_phrases: ["delicious"], display_order: 0 },
    ],
    adAngles: [
      { hook_one_liner: "The morning routine everyone's copying", lead_benefit_anchor: "focus", is_active: true },
    ],
  });
  const ranked = selectAngles(pi);
  // No 'benefit'-sourced angle is emitted when nothing carries role='lead' — the seed is opt-in.
  assert.ok(!ranked.some((a) => a.source === "benefit"), "expected no benefit-source angle without role='lead'");
  // Other candidate paths still populate the pool.
  assert.ok(ranked.some((a) => a.source === "ad_angle"), "expected ad_angle-source angles to still populate");
});

test("selectAngles — a role='lead' row with no customer_phrases falls back to benefit_name as the hook", () => {
  const pi = makePi({
    benefits: [
      { benefit_name: "Weight loss", role: "lead", customer_phrases: null, display_order: 0 },
    ],
  });
  const ranked = selectAngles(pi);
  const seeded = ranked.find((a) => a.source === "benefit");
  assert.ok(seeded, "expected a seeded lead-benefit angle even without customer phrases");
  assert.equal(seeded.hook, "Weight loss");
  assert.equal(seeded.leadBenefit, "Weight loss");
});

// ── buildCreativeBrief: Phase 2 RIFF — weave the lead benefit into a competitor brief ──────────
// dahlia-hooks-riff-competitor-angle-and-weave-in-lead-benefit Phase 2 — every competitor-source
// brief carries the product's role='lead' benefit as a REQUIRED ingredient of the authored hook
// (the strong default RIFF); the minority pure-competitor explore slot passes
// `{ pureCompetitor: true }` to opt out for learning. Own-brand angles never carry the field —
// their hook already carries the benefit.

const AMAZING_COFFEE_PI = () => makePi({
  product: { title: "Amazing Coffee" },
  benefits: [
    {
      benefit_name: "Weight loss",
      role: "lead",
      customer_phrases: ["feel lighter", "lost weight", "curbs my appetite"],
      science_confirmed: true,
      customer_confirmed: true,
      display_order: 0,
    },
    {
      benefit_name: "No jitters",
      role: "supporting",
      customer_phrases: ["no crash", "steady energy"],
      display_order: 1,
    },
  ],
});

const COMPETITOR_ANGLE = (): ScoredAngle => ({
  hook: "Tired of the coffee jitters?",
  source: "competitor",
  leadBenefit: "no jitters",
  acquisitionPower: 8,
  retentionTruth: 6,
  commodity: false,
  hasRealPhoto: false,
  reasons: [],
  raw: { hook: "Tired of the coffee jitters?", framework: "problem→solution", mechanism: "adaptogens", proof: "10k reviews", offer: "50% off", advertiser: "MUD/WTR" },
});

test("buildCreativeBrief — RIFF: competitor angle brief carries leadBenefitWeave from pi.benefits role='lead'", async () => {
  const pi = AMAZING_COFFEE_PI();
  const brief = await buildCreativeBrief(pi, COMPETITOR_ANGLE());
  assert.ok(brief.leadBenefitWeave, "expected leadBenefitWeave on a competitor-source brief with a role='lead' benefit");
  assert.equal(brief.leadBenefitWeave.benefitName, "Weight loss");
  // Soft phrasings are threaded verbatim from the benefit's customer_phrases — grounded, no fabrication.
  assert.deepEqual(brief.leadBenefitWeave.softPhrasings, ["feel lighter", "lost weight", "curbs my appetite"]);
  // Both DNA and weave are present — Dahlia has BOTH the competitor framework AND our lead benefit.
  assert.ok(brief.competitorDna, "expected competitorDna to still be present alongside the weave");
  // The guardrails attest to the RIFF requirement so downstream QC can grep it.
  assert.ok(
    brief.guardrails.some((g) => /RIFF/.test(g) && /weight loss/i.test(g)),
    `expected a RIFF guardrail naming the lead benefit; got ${JSON.stringify(brief.guardrails)}`,
  );
});

test("buildCreativeBrief — minority pure-competitor explore slot ({ pureCompetitor: true }) skips the weave", async () => {
  const pi = AMAZING_COFFEE_PI();
  const brief = await buildCreativeBrief(pi, COMPETITOR_ANGLE(), [], { pureCompetitor: true });
  // The pure-competitor slot ships one pure-borrow imitation per batch for learning — no weave.
  assert.equal(brief.leadBenefitWeave, null);
  // Competitor DNA is still preserved — this is still a competitor imitation, just without the weave.
  assert.ok(brief.competitorDna);
  // The RIFF guardrail is silent in this case.
  assert.ok(!brief.guardrails.some((g) => /RIFF/.test(g)));
});

test("buildCreativeBrief — own-brand angle never carries leadBenefitWeave (the hook already carries the benefit)", async () => {
  const pi = AMAZING_COFFEE_PI();
  const ownAngle: ScoredAngle = {
    hook: "Lost 15 lbs",
    source: "transformation",
    leadBenefit: "Weight loss",
    acquisitionPower: 10,
    retentionTruth: 6,
    commodity: false,
    hasRealPhoto: false,
    reasons: [],
  };
  const brief = await buildCreativeBrief(pi, ownAngle);
  assert.equal(brief.leadBenefitWeave, null);
  assert.ok(!brief.guardrails.some((g) => /RIFF/.test(g)));
});

test("buildCreativeBrief — competitor angle with NO role='lead' benefit degrades gracefully (leadBenefitWeave=null)", async () => {
  const pi = makePi({
    product: { title: "Amazing Coffee" },
    benefits: [
      { benefit_name: "Great taste", role: "supporting", customer_phrases: ["delicious"], display_order: 0 },
    ],
  });
  const brief = await buildCreativeBrief(pi, COMPETITOR_ANGLE());
  assert.equal(brief.leadBenefitWeave, null, "no role='lead' benefit → the RIFF field stays null (today's behavior)");
});
