/**
 * Unit tests for the Phase-2 verify-then-reword surface
 * (dahlia-competitor-ad-adaptation-overlay-render). Pins the deterministic module Dahlia's
 * IMITATE-DEBRANDED rule reads: `selectConfirmedBenefits` filters `pi.benefits` by
 * `customer_confirmed=true` + role ∈ {lead, supporting}; `matchConfirmedBenefit` finds the
 * analogous confirmed benefit for a competitor claim (dimension classifier + phrase/token
 * fallback); `hasDiverseBenefitStack` catches two beats on one dimension; `enforceOfferFidelity`
 * flags an offer we don't run and hands over our sanctioned "Try It Risk-Free" substitute.
 *
 * These are the exact rules the SpoiledChild → Amazing Creamer worked example turns on — the
 * dimension classifier maps their `skin·skin·appetite·digestion` stack onto our confirmed
 * catalog and the offer helper substitutes our real 30-day guarantee for a `Try Before You Buy`
 * competitor CTA.
 *
 * Run: npx tsx --test src/lib/ads/creative-imitation.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ProductIntelligence } from "@/lib/product-intelligence";
import {
  benefitDimensionOf,
  enforceOfferFidelity,
  hasDiverseBenefitStack,
  matchConfirmedBenefit,
  OFFER_SUBSTITUTE_RISK_FREE,
  selectConfirmedBenefits,
  type ConfirmedBenefit,
} from "./creative-imitation";

function pi(benefitRows: Record<string, unknown>[]): ProductIntelligence {
  return { benefits: benefitRows } as unknown as ProductIntelligence;
}

const AMAZING_CREAMER_CATALOG: ConfirmedBenefit[] = [
  { benefitName: "Skin Health", softPhrasings: ["skin is smoother", "less dry"], role: "lead" },
  { benefitName: "Hair Health", softPhrasings: ["hair feels stronger"], role: "lead" },
  { benefitName: "Weight Management", softPhrasings: ["feel lighter", "helps with appetite"], role: "lead" },
  { benefitName: "Digestive Health", softPhrasings: ["no more bloating"], role: "supporting" },
];

// ── selectConfirmedBenefits ──────────────────────────────────────────────────

test("selectConfirmedBenefits: keeps only customer_confirmed=true rows in {lead, supporting} roles", () => {
  const rows = [
    { benefit_name: "Skin Health", role: "lead", customer_confirmed: true, customer_phrases: ["skin is smoother"] },
    { benefit_name: "Weight Management", role: "lead", customer_confirmed: true, customer_phrases: ["feel lighter"] },
    { benefit_name: "Uncurated benefit", role: "lead", customer_confirmed: false, customer_phrases: ["hopeful"] },
    { benefit_name: "Skip benefit", role: "skip", customer_confirmed: true, customer_phrases: [] },
    { benefit_name: "Supporting truth", role: "supporting", customer_confirmed: true, customer_phrases: ["tasty"] },
  ];
  const out = selectConfirmedBenefits(pi(rows));
  assert.equal(out.length, 3, "3 confirmed + role-eligible rows");
  assert.deepEqual(out.map((b) => b.benefitName), ["Skin Health", "Weight Management", "Supporting truth"]);
  assert.deepEqual(out[0].softPhrasings, ["skin is smoother"], "lifts customer_phrases verbatim");
  assert.equal(out[2].role, "supporting");
});

test("selectConfirmedBenefits: drops rows with empty benefit_name and handles missing customer_phrases", () => {
  const rows = [
    { benefit_name: "  ", role: "lead", customer_confirmed: true, customer_phrases: [] },
    { benefit_name: "Focus", role: "supporting", customer_confirmed: true }, // no customer_phrases key at all
  ];
  const out = selectConfirmedBenefits(pi(rows));
  assert.equal(out.length, 1);
  assert.equal(out[0].benefitName, "Focus");
  assert.deepEqual(out[0].softPhrasings, [], "missing customer_phrases → empty softPhrasings");
});

// ── benefitDimensionOf ───────────────────────────────────────────────────────

test("benefitDimensionOf: classifies known benefit tokens into deterministic dimensions", () => {
  assert.equal(benefitDimensionOf("smooth skin"), "skin");
  assert.equal(benefitDimensionOf("Skin Health"), "skin");
  assert.equal(benefitDimensionOf("Hair Health"), "hair");
  assert.equal(benefitDimensionOf("Weight Management"), "weight");
  assert.equal(benefitDimensionOf("your pants size might shrink"), "weight");
  assert.equal(benefitDimensionOf("feel lighter"), "weight");
  assert.equal(benefitDimensionOf("curb cravings"), "appetite");
  assert.equal(benefitDimensionOf("reduce bloating"), "digestion");
  assert.equal(benefitDimensionOf("no more bloat"), "digestion");
  assert.equal(benefitDimensionOf("no crash, no jitters"), "energy");
  assert.equal(benefitDimensionOf("sharper focus"), "focus");
  assert.equal(benefitDimensionOf("deep sleep"), "sleep");
  assert.equal(benefitDimensionOf("no-idea benefit"), null, "unknown returns null");
});

// ── hasDiverseBenefitStack ───────────────────────────────────────────────────

test("hasDiverseBenefitStack: passes on four distinct dimensions (Amazing Creamer's stack)", () => {
  assert.equal(hasDiverseBenefitStack(["Skin Health", "Hair Health", "Weight Management", "Digestive Health"]), true);
});

test("hasDiverseBenefitStack: fails on two beats sharing one dimension (SpoiledChild's skin×2)", () => {
  assert.equal(hasDiverseBenefitStack(["Smooth Skin", "Plump Skin", "Curb Cravings", "Reduce Bloating"]), false, "skin×2 collapses to one bucket");
});

test("hasDiverseBenefitStack: unknown-dimension benefits are distinct buckets (not silently collapsed)", () => {
  assert.equal(hasDiverseBenefitStack(["Focus", "Novel benefit A", "Novel benefit B"]), true);
});

// ── matchConfirmedBenefit ────────────────────────────────────────────────────

test("matchConfirmedBenefit: SpoiledChild's four benefits each find an analogous confirmed benefit on Amazing Creamer", () => {
  // Worked-example trace from reference/competitor-ad-adaptation Part 1 (SpoiledChild → Amazing Creamer).
  assert.equal(matchConfirmedBenefit("smooth wrinkles", AMAZING_CREAMER_CATALOG)?.benefitName, "Skin Health");
  assert.equal(matchConfirmedBenefit("plump skin", AMAZING_CREAMER_CATALOG)?.benefitName, "Skin Health");
  assert.equal(matchConfirmedBenefit("curb cravings", AMAZING_CREAMER_CATALOG)?.benefitName, "Weight Management", "appetite dim resolves via softPhrasings + wins the lead-role tiebreak toward Weight Management");
  assert.equal(matchConfirmedBenefit("reduce bloating", AMAZING_CREAMER_CATALOG)?.benefitName, "Digestive Health");
  assert.equal(matchConfirmedBenefit("your pants size might shrink", AMAZING_CREAMER_CATALOG)?.benefitName, "Weight Management");
});

test("matchConfirmedBenefit: prefers a role='lead' hit when several confirmed benefits share the dim", () => {
  const catalog: ConfirmedBenefit[] = [
    { benefitName: "Support Skin", softPhrasings: [], role: "supporting" },
    { benefitName: "Skin Health", softPhrasings: [], role: "lead" },
  ];
  assert.equal(matchConfirmedBenefit("smooth skin", catalog)?.benefitName, "Skin Health");
});

test("matchConfirmedBenefit: returns null when the competitor's benefit has NO analogous confirmed benefit (SUBSTITUTE signal)", () => {
  // Bloom's "gut / immunity" against a collagen creamer that lacks both → null → SUBSTITUTE.
  assert.equal(matchConfirmedBenefit("immunity boost", AMAZING_CREAMER_CATALOG), null);
  assert.equal(matchConfirmedBenefit("deeper sleep", AMAZING_CREAMER_CATALOG), null);
});

// ── enforceOfferFidelity ─────────────────────────────────────────────────────

test("enforceOfferFidelity: 'Try Before You Buy' triggers substitute with our real risk-free CTA", () => {
  const v = enforceOfferFidelity("Try Before You Buy — free 14-day trial");
  assert.equal(v.needsSubstitute, true);
  assert.equal(v.substitute, OFFER_SUBSTITUTE_RISK_FREE);
  assert.match(v.reason ?? "", /try before you buy/);
});

test("enforceOfferFidelity: 'Free Trial' / BOGO / GWP freebie / Free Tote all trigger the substitute", () => {
  for (const cta of ["Free trial today", "Get one free", "BOGO", "Buy one get one", "Free tote with subscription", "Bonus gift", "GWP for orders over $50", "Free sample kit"]) {
    const v = enforceOfferFidelity(cta);
    assert.equal(v.needsSubstitute, true, `expected substitute for cta='${cta}'`);
    assert.equal(v.substitute, OFFER_SUBSTITUTE_RISK_FREE);
  }
});

test("enforceOfferFidelity: a benign CTA ('Shop Now') passes through with no substitute", () => {
  const v = enforceOfferFidelity("Shop Now");
  assert.equal(v.needsSubstitute, false);
  assert.equal(v.substitute, null);
  assert.equal(v.reason, null);
});

test("enforceOfferFidelity: null / empty CTA is a no-op", () => {
  assert.deepEqual(enforceOfferFidelity(null), { needsSubstitute: false, reason: null, substitute: null });
  assert.deepEqual(enforceOfferFidelity(""), { needsSubstitute: false, reason: null, substitute: null });
});
