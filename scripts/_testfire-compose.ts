/**
 * _testfire-compose — end-to-end test-fire of the v3 authoring core (Angle × Pattern → Headline),
 * in-memory (real Claude calls, no DB). Proves: (1) theme-spread variety — no mono-angle
 * convergence; (2) grounded, on-strategy cold headlines; (3) evidence-tier honesty (a customer_only
 * angle leads with the review, not a clinical claim); (4) the "5 patterns on one angle" = 5 variations.
 *
 * Run: npx tsx scripts/_testfire-compose.ts
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { HEADLINE_PATTERN_SEED, type HeadlinePattern } from "../src/lib/ads/headline-patterns";
import { composeHeadline } from "../src/lib/ads/compose-headline";
import type { ProductAngle, AngleTheme, EvidenceTier } from "../src/lib/ads/angle-palette";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BRAND_PROOF = [
  "30-day money-back guarantee", "700,000+ customers", "15,000+ 5-star reviews", "Non-GMO, 3rd-party tested",
];

const pattern = (slug: string): HeadlinePattern => {
  const p = HEADLINE_PATTERN_SEED.find((x) => x.slug === slug)!;
  return { id: `seed-${slug}`, ...p };
};

// one representative angle per theme (from the real creamer seed) — cast the coverage fields as stubs
const angle = (a: Partial<ProductAngle> & { theme: AngleTheme; problem: string; evidenceTier: EvidenceTier }): ProductAngle => ({
  id: "stub", productId: "creamer", ingredients: [], benefitKey: null, enemy: null, mechanism: null,
  desiredOutcome: null, proofText: null, proofKind: null, backingReviewIds: [], searchDemand: "high",
  awarenessStages: ["cold", "warm", "hot"], source: "seeded", timesUsed: 0, lastUsedAt: null,
  status: "fresh", isActive: true, displayOrder: 0, notes: null, ...a,
});

const SPREAD: Array<{ a: ProductAngle; p: string }> = [
  { a: angle({ theme: "beauty", problem: "wrinkles & aging skin", ingredients: ["collagen", "hyaluronic_acid"], enemy: "serums", mechanism: "collagen + hyaluronic acid rebuild skin from within", desiredOutcome: "younger, smoother skin", proofText: "35% wrinkle-score drop at 12 weeks", evidenceTier: "science_strong" }), p: "reframe" },
  { a: angle({ theme: "beauty", problem: "thinning hair & brittle nails", ingredients: ["collagen"], enemy: "biotin gummies", mechanism: "collagen feeds hair follicles + nail beds", desiredOutcome: "thicker hair, stronger nails", proofText: "customer: \"my hair is thicker, thick healthy hair, strong fingernails\"", evidenceTier: "customer_only" }), p: "problem-agitate" },
  { a: angle({ theme: "healthy_weight", problem: "stubborn belly fat", ingredients: ["mct_oil", "collagen"], enemy: "another diet", mechanism: "MCT burns fat while collagen preserves muscle", desiredOutcome: "lose the belly, keep the muscle", proofText: "MCT beat olive oil on belly fat at 16 weeks; customer: \"I've lost 29lbs\"", evidenceTier: "science_modest" }), p: "reframe" },
  { a: angle({ theme: "focus", problem: "brain fog & the afternoon slump", ingredients: ["mct_oil"], enemy: "another cup of coffee", mechanism: "MCT ketones fuel the brain within the half hour", desiredOutcome: "a clear head by the second sip", proofText: "ketones in 15-30 min lift brain fog; customer: \"my brain is sharper\"", evidenceTier: "science_modest" }), p: "reframe" },
  { a: angle({ theme: "longevity", problem: "joint pain & stiff knees", ingredients: ["collagen", "hyaluronic_acid"], enemy: "another glucosamine pill", mechanism: "collagen + hyaluronic acid cushion and rebuild the joint", desiredOutcome: "move without the stiffness", proofText: "cartilage repair; oral HA eased knee OA at 8-12 weeks", evidenceTier: "science_strong" }), p: "curiosity-gap" },
  { a: angle({ theme: "gut", problem: "bloating & leaky gut", ingredients: ["collagen", "mct_oil"], enemy: "another probiotic", mechanism: "collagen repairs the gut lining while MCT balances the microbiome", desiredOutcome: "the bloat is gone", proofText: "collagen 20g/8wk cut bloating", evidenceTier: "science_modest" }), p: "reframe" },
];

async function fire(a: ProductAngle, pslug: string, temperature: "cold" | "warm" | "hot" = "cold") {
  const r = await composeHeadline({ workspaceId: WS, productTitle: "Amazing Creamer", angle: a, pattern: pattern(pslug), temperature, brandProofPoints: BRAND_PROOF, realOffer: temperature === "cold" ? null : "34% off + free shipping" });
  return r;
}

async function main() {
  console.log("═══ TEST-FIRE 1: theme-spread (cold) — variety, no convergence ═══\n");
  for (const { a, p } of SPREAD) {
    const r = await fire(a, p);
    console.log(`[${a.theme}] pattern=${p} tier=${a.evidenceTier}`);
    console.log(`  HEADLINE (${r?.headline.length}c): ${r?.headline ?? "(no key / null)"}`);
    console.log(`  primary: ${r?.primaryText ?? ""}`);
    console.log(`  used: ${r?.usedParts.join(", ") ?? ""}\n`);
  }

  console.log("\n═══ TEST-FIRE 2: five patterns on ONE angle (the 5 variations) — beauty/collagen ═══\n");
  const skin = SPREAD[0].a;
  for (const p of ["reframe", "curiosity-gap", "villain-callout", "mechanism-reveal", "story"]) {
    const r = await fire(skin, p);
    console.log(`[${p}] ${r?.headline ?? "(null)"}`);
  }

  console.log("\n═══ TEST-FIRE 3: warm/hot retarget — same angle KEEPS the real offer ═══\n");
  for (const t of ["warm", "hot"] as const) {
    const r = await fire(SPREAD[0].a, t === "hot" ? "offer" : "social-proof", t);
    console.log(`[${t}] ${r?.headline ?? "(null)"}  ::  ${r?.primaryText ?? ""}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e); process.exit(1); });
