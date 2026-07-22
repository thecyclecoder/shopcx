/**
 * _seed-angle-palette-creamer — one-time seed of Amazing Creamer's v3 angle palette + the shared
 * headline-pattern library. Idempotent (upserts on the natural keys). Grounded in the demand sweep
 * (search-first) + our confirmed benefit trunk (getProductIntelligence) + real reviews.
 *
 * Run: npx tsx scripts/_seed-angle-palette-creamer.ts
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { seedHeadlinePatterns } from "../src/lib/ads/headline-patterns";
import { upsertAngle, type AnglePaletteInput } from "../src/lib/ads/angle-palette";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company
const CREAMER = "61a4490e-cb2a-4f65-9613-faab40f0b153";

// Demand: 🔥 high / 🟡 medium. Evidence tier = proof STYLE (never a filter). Angles keyed on problem.
const ANGLES: AnglePaletteInput[] = [
  // ── 🪞 BEAUTY ──────────────────────────────────────────────────────────────
  {
    theme: "beauty", problem: "wrinkles & aging skin", ingredients: ["collagen", "hyaluronic_acid"],
    benefitKey: "Skin Health & Hydration", enemy: "serums",
    mechanism: "collagen + hyaluronic acid rebuild skin from within",
    desiredOutcome: "younger, smoother skin", proofText: "35% wrinkle-score drop at 12 weeks; you lose 1%/yr after 40",
    proofKind: "clinical_stat", evidenceTier: "science_strong", searchDemand: "high", displayOrder: 1,
  },
  {
    theme: "beauty", problem: "dry, flat, dull skin", ingredients: ["hyaluronic_acid"],
    benefitKey: "Skin Health & Hydration", enemy: "topical serums you dab on",
    mechanism: "hyaluronic acid hydrates + plumps from the inside",
    desiredOutcome: "plump, dewy skin", proofText: "holds 1,000x its weight in water; oral HA improved wrinkles + hydration at 12 weeks",
    proofKind: "clinical_stat", evidenceTier: "science_strong", searchDemand: "high", displayOrder: 2,
  },
  {
    theme: "beauty", problem: "thinning hair & brittle nails", ingredients: ["collagen"],
    benefitKey: "Skin Health & Hydration", enemy: "biotin gummies",
    mechanism: "collagen feeds hair follicles + nail beds",
    desiredOutcome: "thicker hair, stronger nails", proofText: "customer: \"my hair is thicker and my skin is smoother\" · \"thick healthy hair, strong fingernails\"",
    proofKind: "customer_review", evidenceTier: "customer_only", searchDemand: "high", displayOrder: 3,
  },
  // ── ⏳ LONGEVITY ───────────────────────────────────────────────────────────
  {
    theme: "longevity", problem: "joint pain & stiff knees", ingredients: ["collagen", "hyaluronic_acid"],
    benefitKey: "Joint Health & Mobility", enemy: "another glucosamine pill",
    mechanism: "collagen + hyaluronic acid cushion and rebuild the joint",
    desiredOutcome: "move without the stiffness", proofText: "cartilage repair (41-study analysis); oral HA eased knee OA at 8-12 weeks",
    proofKind: "clinical_stat", evidenceTier: "science_strong", searchDemand: "high", displayOrder: 4,
  },
  {
    theme: "longevity", problem: "losing muscle & strength after 40", ingredients: ["collagen"],
    benefitKey: "Muscle Mass & Recovery", enemy: "just more protein powder",
    mechanism: "collagen strengthens tendons and helps preserve lean mass",
    desiredOutcome: "keep your strength as you age", proofText: "15g + resistance training → more fat-free mass, less fat; tendons are 85% collagen",
    proofKind: "clinical_stat", evidenceTier: "science_modest", searchDemand: "high", displayOrder: 5,
  },
  {
    theme: "longevity", problem: "weak, aging bones", ingredients: ["collagen"],
    benefitKey: "Bone Health & Density", enemy: "calcium alone",
    mechanism: "collagen slows the bone breakdown that thins your bones",
    desiredOutcome: "denser, stronger bones", proofText: "up to 7% bone-mineral-density increase",
    proofKind: "clinical_stat", evidenceTier: "science_modest", searchDemand: "medium", displayOrder: 6,
  },
  {
    theme: "longevity", problem: "restless, broken sleep", ingredients: ["collagen"],
    benefitKey: "Skin Health & Hydration", enemy: "melatonin",
    mechanism: "the glycine in collagen eases you into deeper sleep",
    desiredOutcome: "wake up actually rested", proofText: "3g glycine before bed improved sleep quality + cut daytime grogginess",
    proofKind: "clinical_stat", evidenceTier: "science_modest", searchDemand: "medium", displayOrder: 7,
  },
  // ── ⚖️ HEALTHY WEIGHT ──────────────────────────────────────────────────────
  {
    theme: "healthy_weight", problem: "stubborn belly fat", ingredients: ["mct_oil", "collagen"],
    benefitKey: "Weight Management & Fat Loss", enemy: "another diet",
    mechanism: "MCT burns fat while collagen preserves the muscle you'd otherwise lose",
    desiredOutcome: "lose the belly, keep the muscle", proofText: "MCT beat olive oil on belly fat at 16 weeks; customer: \"I've lost 29lbs since using this\"",
    proofKind: "clinical_stat", evidenceTier: "science_modest", searchDemand: "high", displayOrder: 8,
  },
  {
    theme: "healthy_weight", problem: "constant cravings & always hungry", ingredients: ["mct_oil", "collagen"],
    benefitKey: "Weight Management & Fat Loss", enemy: "willpower and snacking",
    mechanism: "MCT triggers fullness hormones + protein keeps you full for hours",
    desiredOutcome: "the cravings just stop", proofText: "satiety hormones + 4-hr protein fullness; customer: \"I don't get that much hungry\"",
    proofKind: "customer_review", evidenceTier: "science_modest", searchDemand: "high", displayOrder: 9,
  },
  {
    theme: "healthy_weight", problem: "blood-sugar spikes & crashes", ingredients: ["collagen"],
    benefitKey: "Weight Management & Fat Loss", enemy: "cutting out all carbs",
    mechanism: "the glycine in collagen slows how fast sugar hits your blood",
    desiredOutcome: "steady energy, no sugar crash", proofText: "glycine slows glucose absorption in the gut",
    proofKind: "mechanism", evidenceTier: "science_modest", searchDemand: "medium", displayOrder: 10,
  },
  // ── ⚡ ENERGY & PERFORMANCE ─────────────────────────────────────────────────
  {
    theme: "energy_performance", problem: "energy that crashes by 2pm", ingredients: ["mct_oil"],
    benefitKey: "Energy & Athletic Performance", enemy: "more coffee & energy drinks",
    mechanism: "MCT converts to clean ketone energy with no sugar spike",
    desiredOutcome: "energy that doesn't crash", proofText: "rapid ketone energy, no insulin spike",
    proofKind: "mechanism", evidenceTier: "science_strong", searchDemand: "high", displayOrder: 11,
  },
  {
    theme: "energy_performance", problem: "hitting the wall in your workout", ingredients: ["mct_oil"],
    benefitKey: "Energy & Athletic Performance", enemy: "sugary pre-workout",
    mechanism: "MCT fuels the workout with fat instead of sugar",
    desiredOutcome: "train longer, recover faster", proofText: "worked at 80% VO2max longer; lower lactate + fatigue vs long-chain fats",
    proofKind: "clinical_stat", evidenceTier: "science_modest", searchDemand: "high", displayOrder: 12,
  },
  // ── 🧠 FOCUS ────────────────────────────────────────────────────────────────
  {
    theme: "focus", problem: "brain fog & the afternoon slump", ingredients: ["mct_oil"],
    benefitKey: "Mental Clarity & Focus", enemy: "another cup of coffee",
    mechanism: "MCT ketones fuel the brain within the half hour",
    desiredOutcome: "a clear head by the second sip", proofText: "ketones in 15-30 min lift brain fog; customer: \"my brain is sharper\"",
    proofKind: "customer_review", evidenceTier: "science_modest", searchDemand: "high", displayOrder: 13,
  },
  // ── 🦠 GUT ──────────────────────────────────────────────────────────────────
  {
    theme: "gut", problem: "bloating & leaky gut", ingredients: ["collagen", "mct_oil"],
    benefitKey: "Digestive Health", enemy: "another probiotic",
    mechanism: "collagen repairs the gut lining while MCT balances the microbiome",
    desiredOutcome: "the bloat is gone", proofText: "collagen 20g/8wk cut bloating; MCT feeds good bacteria + curbs candida",
    proofKind: "clinical_stat", evidenceTier: "science_modest", searchDemand: "high", displayOrder: 14,
  },
];

async function main() {
  const admin = createAdminClient();
  const n = await seedHeadlinePatterns(admin, WS);
  console.log(`✓ seeded ${n} headline patterns`);
  let ok = 0;
  for (const a of ANGLES) {
    await upsertAngle(admin, WS, CREAMER, { ...a, source: "seeded" });
    ok++;
  }
  console.log(`✓ seeded ${ok} Amazing Creamer angles across 6 themes`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e); process.exit(1); });
