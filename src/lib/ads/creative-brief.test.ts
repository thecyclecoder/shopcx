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
import { buildMetaCopy, type CreativeBrief, type ScoredAngle } from "./creative-brief";
import { hasAnyLf8 } from "./lf8";

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
