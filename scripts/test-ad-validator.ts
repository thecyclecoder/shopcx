/**
 * Phase 0.5 completion test for the Direct Response Validator.
 *
 *   npx tsx scripts/test-ad-validator.ts
 *
 * Asserts the validator:
 *   1. REJECTS a deliberately "safe" script (warm intro + soft words + soft CTA).
 *   2. REJECTS a script whose central claim cites only a review (no tier-1/2 anchor).
 *   3. ACCEPTS a properly anchored, direct-response script.
 *
 * Pure logic — no DB / API calls.
 */
import { validateAdScript } from "../src/lib/ad-validator";
import type { AngleGeneratorInput, ProductAdAngle } from "../src/lib/ad-types";

const inputs: AngleGeneratorInput = {
  product_id: "test",
  product_title: "Amazing Coffee",
  hero_headline: "Brew. Sip. Shed Pounds & Fight Aging.",
  hero_subheadline: "The coffee that does more than wake you up.",
  benefit_bar: [
    { text: "Crushes afternoon brain fog" },
    { text: "All-day clean energy" },
    { text: "Curbs appetite and supports weight loss" },
    { text: "Cardiovascular support" },
  ],
  guarantee_copy: "30-day money-back guarantee",
  expectation_timeline: [],
  lead_benefits: [
    { name: "Crushes afternoon brain fog", customer_phrases: ["I used to crash at 3pm and now I don't"], ingredient_research_ids: [], ai_confidence: 0.9 },
    { name: "All-day clean energy", customer_phrases: ["No jitters, no crash"], ingredient_research_ids: [], ai_confidence: 0.85 },
  ],
  ingredient_science: [
    { ingredient_name: "L-theanine", benefit_headline: "Smooths caffeine into clean focus", clinically_studied_benefits: ["reduced jitters"], citations: [] },
  ],
  proof_quotes: [{ rating: 5, quote: "I lost 8 pounds in my first month without trying" }],
  credibility: {
    certifications: ["Non-GMO", "3rd Party Tested"],
    allergen_free: ["Gluten Free"],
    awards: ["Best Tasting — Gourmet Magazine"],
    review_count: 13018,
    review_avg: 4.8,
    clinical_study_count: 117,
    brand_proof_points: "13,018 five-star reviews",
  },
  target_customer: "women 35-54 fighting afternoon crashes",
  physical_dimensions: { length_in: 7, width_in: 3, height_in: 12, shape: "bag" },
  variant_isolated_image_url: "https://example.com/iso.png",
};

const goodAngle: Pick<ProductAdAngle, "meta_headline" | "meta_primary_text" | "meta_description" | "proof_anchor"> = {
  meta_headline: "Kill the 3pm crash for good",
  meta_primary_text: "13,018 reviews. One cup. Clean energy that actually lasts past lunch.",
  meta_description: "Try it risk-free 30 days",
  proof_anchor: { type: "stat", value: "13,018+ reviews" },
};

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. "Safe" script — warm intro, banned soft words, soft CTA.
const safeScript = `Hey guys! Introducing Amazing Coffee — a natural wellness blend that supports your energy and helps promote focus. Click to learn more.`;
const r1 = validateAdScript(safeScript, goodAngle, inputs);
console.log("\nTest 1 — safe script:");
check("rejected", !r1.ok, "expected ok=false");
check("flags warm opener", r1.violations.some((v) => v.code === "warm_opener"));
check("flags banned word", r1.violations.some((v) => v.code === "banned_word"));
check("flags soft CTA", r1.violations.some((v) => v.code === "soft_cta"));

// 2. Central claim rests only on a review, no tier-1/2 anchor.
const reviewOnlyScript = `Real customer: "This cured my insomnia and reversed my arthritis overnight." That's why everyone is switching. Grab yours before the next batch sells out.`;
const r2 = validateAdScript(reviewOnlyScript, goodAngle, inputs);
console.log("\nTest 2 — review-only central claim:");
check("rejected", !r2.ok, "expected ok=false");
check(
  "flags review-as-promise or unanchored",
  r2.violations.some((v) => v.code === "review_as_promise" || v.code === "unanchored_claim"),
);

// 3. Properly anchored direct-response script.
const goodScript = `If you crash hard at 3pm every single day, your coffee is the problem. Most coffee spikes you then drops you. Amazing Coffee gives you all-day clean energy and crushes that afternoon brain fog. Real customer: "No jitters, no crash." Grab yours before the next batch sells out.`;
const r3 = validateAdScript(goodScript, goodAngle, inputs);
console.log("\nTest 3 — anchored DR script:");
check("accepted", r3.ok, `violations: ${JSON.stringify(r3.violations)}`);

console.log("");
if (failures > 0) {
  console.error(`✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("✓ all validator assertions passed");
