/**
 * buildMetaCopy — the Meta ad text Dahlia publishes. Guards the 2026-07-13 fixes:
 *   - headline is a benefit/hook, NEVER the offer
 *   - primaryText is a real structured caption (opener + benefits + proof + offer/CTA), not a fragment
 *   - description carries the offer, never empty
 *   - a competitor angle's raw hook (may carry the competitor's brand) NEVER reaches the copy
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildMetaCopy } from "../src/lib/ads/creative-brief";
import { META_CAPS } from "../src/lib/ad-tool-config";
import type { CreativeBrief } from "../src/lib/ads/creative-brief";
import type { ScoredAngle } from "../src/lib/ads/creative-brief";

const baseAngle = (over: Partial<ScoredAngle> = {}): ScoredAngle => ({
  hook: "I lost 40+ pounds!",
  source: "transformation",
  leadBenefit: "Weight loss (real customer transformation)",
  acquisitionPower: 9, retentionTruth: 5, commodity: false, hasRealPhoto: false, reasons: [],
  ...over,
});

const baseBrief = (over: Partial<CreativeBrief> = {}): CreativeBrief => ({
  productTitle: "Amazing Coffee",
  angle: baseAngle(),
  leadProof: null,
  transformation: { reviewer: "Barbara H.", quote: "I lost 40+ pounds and never gave up my coffee.", beforeAfterImage: null },
  supportingBenefits: ["appetite & craving control", "clean energy without the crash"],
  proofStack: ["Best Tasting Superfood Coffee", "Non-GMO", "3rd Party Tested", "Made In The USA"],
  offer: { headline: "Up to 34% off + free shipping", strikethrough: null, perServing: "$1.76/serving vs a $4–8 coffee/latte", disclaimer: "" },
  imageRefs: [], guardrails: [],
  ...over,
});

test("headline is the hook/benefit, never the offer", () => {
  const c = buildMetaCopy(baseBrief());
  assert.ok(!/34% off|free shipping/i.test(c.headline), "offer must not be the headline");
  assert.ok(c.headline.length <= META_CAPS.headline);
  assert.equal(c.headline, "I lost 40+ pounds!");
});

test("primaryText is a real caption — opener, proof, offer + CTA — within cap", () => {
  const c = buildMetaCopy(baseBrief());
  assert.ok(c.primaryText.includes("Barbara H."), "leads with the real reviewer quote");
  assert.ok(c.primaryText.includes("Up to 34% off"), "carries the offer");
  assert.ok(/shop now/i.test(c.primaryText), "has a CTA");
  assert.ok(c.primaryText.includes("\n"), "is multi-line, not a single fragment");
  assert.ok(c.primaryText.length <= META_CAPS.primary_text);
  assert.ok(c.primaryText.length > 125, "richer than the old 125-char terse cap");
});

test("description carries the offer and is never empty", () => {
  const c = buildMetaCopy(baseBrief());
  assert.ok(c.description.length > 0);
  assert.ok(c.description.length <= META_CAPS.description);
  assert.ok(/serving|off/i.test(c.description));
});

test("competitor angle: the raw (brand-carrying) hook NEVER reaches the copy", () => {
  const brief = baseBrief({
    angle: baseAngle({ hook: "MUD\\WTR vs Ryze", source: "competitor", leadBenefit: "coffee alternative" }),
    transformation: null,
    leadProof: { kind: "review", text: "Best coffee swap I ever made.", attribution: "Dana P." },
  });
  const c = buildMetaCopy(brief);
  const all = `${c.headline}\n${c.primaryText}\n${c.description}`;
  assert.ok(!/MUD.?WTR/i.test(all), "no competitor brand in the copy");
  assert.ok(!/\bRyze\b/i.test(all), "no competitor brand in the copy");
  assert.ok(c.headline.length > 0 && !/34% off/i.test(c.headline));
});
