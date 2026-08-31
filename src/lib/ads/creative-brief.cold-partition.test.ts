/**
 * selectAnglesForTemperature cold-PARTITION tests — pin the CEO 2026-08-31 rule:
 *   "just b/c a competitor ad may have a somewhat 'warm' element — ie a price offer etc — doesn't
 *    mean we can't modify that ad into a cold one."
 *
 *   npm run test:creative-brief-cold-partition
 *
 * The regression this locks: the cold path used to `.filter()` warm/hot-looking competitor angles
 * OUT entirely, which starved the shelf — Amazing Coffee K-Cups' 40 shared angles collapsed to 1 and
 * Superfood Tabs' 19 to 0. Combined with the explore-requires-competitor rail that meant almost no
 * cold ads at all. It also contradicted itself: `imageOfferForAudience` BLANKS `brief.offer` on
 * every cold angle before generation, so an ad was deleted for carrying an offer one step before
 * that offer would have been deleted.
 *
 * Ground truth for the fixtures is the real Erth Labs shelf on 2026-08-31.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { selectAnglesForTemperature, type ScoredAngle } from "./creative-brief";
import { offerIsHardDiscount } from "./creative-sourcing";

type Tags = NonNullable<ScoredAngle["conceptTags"]>;
const angle = (hook: string, offer: string | null, tags?: Partial<Tags>): ScoredAngle => ({
  hook, source: "competitor", leadBenefit: "", acquisitionPower: 9, retentionTruth: 5,
  commodity: false, hasRealPhoto: false, reasons: [],
  conceptTags: (tags ?? null) as Tags | null,
  raw: { offer },
} as unknown as ScoredAngle);

const own = (hook: string): ScoredAngle => ({
  hook, source: "review_cluster", leadBenefit: "", acquisitionPower: 5, retentionTruth: 5,
  commodity: false, hasRealPhoto: false, reasons: [], conceptTags: null, raw: {},
} as unknown as ScoredAngle);

// ── offerIsHardDiscount ──────────────────────────────────────────────────────
test("price framing is NOT a hard discount", () => {
  for (const o of ["As low as $0.90 per cup", "$0.90 a day", "Taste it Today", "per serving pricing"]) {
    assert.equal(offerIsHardDiscount(o), false, `"${o}" should read as price framing`);
  }
});

test("real discount levers ARE hard discounts", () => {
  for (const o of ["40% OFF + FREE Starter Kit", "60% OFF", "BOGO", "Save $10", "Spring Shred Sale", "buy one get one"]) {
    assert.equal(offerIsHardDiscount(o), true, `"${o}" should read as a discount`);
  }
});

test("an empty or missing offer is not a discount", () => {
  assert.equal(offerIsHardDiscount(null), false);
  assert.equal(offerIsHardDiscount(""), false);
  assert.equal(offerIsHardDiscount("   "), false);
});

// ── the partition ────────────────────────────────────────────────────────────
test("NOTHING is deleted on cold — a starved shelf was the bug", () => {
  const pool = [
    angle("40% off today only", "60% OFF + FREE Starter Kit"),
    angle("Most coffee is contaminated.", null, { awareness_stage: "problem_aware" } as Partial<Tags>),
    angle("Stopped Ozempic, Kept Losing Weight", "As low as $0.90 per cup", { cialdini_lever: "social_proof" } as Partial<Tags>),
  ];
  const out = selectAnglesForTemperature(pool, [], "cold");
  assert.equal(out.length, 3, "every competitor angle stays usable — ranked, not filtered");
});

test("a cold-focal angle outranks a price-framed one, which outranks a real discount", () => {
  const discount = angle("40% off today", "60% OFF + FREE Starter Kit");
  const priceFramed = angle("Stopped Ozempic, Kept Losing Weight", "As low as $0.90 per cup", { cialdini_lever: "social_proof" } as Partial<Tags>);
  const coldFocal = angle("Most coffee is contaminated.", null, { awareness_stage: "problem_aware" } as Partial<Tags>);

  const out = selectAnglesForTemperature([discount, priceFramed, coldFocal], [], "cold");
  assert.deepEqual(out.map((a) => a.hook), [coldFocal.hook, priceFramed.hook, discount.hook]);
});

test("the real Erth Labs 120d winner is usable on cold, not deleted", () => {
  // Rejected outright before the fix, solely because `offer` was non-empty.
  const ozempic = angle("Stopped Ozempic, Kept Losing Weight", "As low as $0.90 per cup", {
    cialdini_lever: "social_proof", awareness_stage: "solution_aware", archetype: "us-vs-them",
  } as Partial<Tags>);
  const out = selectAnglesForTemperature([ozempic], [], "cold");
  assert.equal(out.length, 1);
  assert.equal(out[0].hook, ozempic.hook);
});

test("ordering is STABLE within a tier so the caller's proven-ness ranking survives", () => {
  const a1 = angle("first discount", "50% OFF");
  const a2 = angle("second discount", "40% OFF");
  const a3 = angle("third discount", "30% OFF");
  const out = selectAnglesForTemperature([a1, a2, a3], [], "cold");
  assert.deepEqual(out.map((a) => a.hook), ["first discount", "second discount", "third discount"]);
});

test("own-brand angles still trail the competitor block", () => {
  const out = selectAnglesForTemperature([angle("comp hook", "60% OFF")], [own("our review cluster")], "cold");
  assert.deepEqual(out.map((a) => a.source), ["competitor", "review_cluster"]);
});

test("warm and hot are untouched — no reordering, no filtering", () => {
  const pool = [angle("b", "60% OFF"), angle("a", null)];
  for (const t of ["warm", "hot"] as const) {
    assert.deepEqual(selectAnglesForTemperature(pool, [], t).map((x) => x.hook), ["b", "a"]);
  }
});
