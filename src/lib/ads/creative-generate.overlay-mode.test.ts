/**
 * Unit tests for the DAHLIA_RENDER_MODE=overlay flag gate + the text-free scene prompt
 * (dahlia-competitor-ad-adaptation-overlay-render Phase 1). Pins the deterministic surface of the
 * new render branch — the flag reader is a pure env check and the text-free prompt forbids the
 * exact failure modes the reference calls out (Nano Banana sneaking in a "CINNAMON LATTE" caption,
 * a photoshopped-in packshot, a clipped hero pack, a competitor's brand leaking in).
 *
 * The compositor itself is covered in `creative-overlay.test.ts`; `generateCreative`'s branch
 * calls Nano Banana Pro (network) so this file does NOT drive the whole flow — that's an
 * integration concern.
 *
 * Run: npx tsx --test src/lib/ads/creative-generate.overlay-mode.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { CreativeBrief } from "@/lib/ads/creative-brief";
import { buildTextFreeScenePrompt, isOverlayRenderModeEnabled, OVERLAY_RENDER_MODE_FLAG } from "./creative-generate";

function brief(): CreativeBrief {
  return {
    productTitle: "Amazing Creamer",
    angle: { hook: "SORRY IN ADVANCE", source: "competitor", leadBenefit: "skin + weight", acquisitionPower: 9, retentionTruth: 8, commodity: false, hasRealPhoto: false, reasons: [] },
    leadProof: null,
    transformation: null,
    supportingBenefits: [],
    proofStack: ["Non-GMO"],
    offer: null,
    imageRefs: [],
    guardrails: [],
  } as unknown as CreativeBrief;
}

test("isOverlayRenderModeEnabled: true only when DAHLIA_RENDER_MODE === 'overlay'", () => {
  const prior = process.env.DAHLIA_RENDER_MODE;
  try {
    delete process.env.DAHLIA_RENDER_MODE;
    assert.equal(isOverlayRenderModeEnabled(), false, "unset → false");
    process.env.DAHLIA_RENDER_MODE = "";
    assert.equal(isOverlayRenderModeEnabled(), false, "empty → false");
    process.env.DAHLIA_RENDER_MODE = "deterministic";
    assert.equal(isOverlayRenderModeEnabled(), false, "wrong value → false");
    process.env.DAHLIA_RENDER_MODE = OVERLAY_RENDER_MODE_FLAG;
    assert.equal(isOverlayRenderModeEnabled(), true, "'overlay' → true");
    process.env.DAHLIA_RENDER_MODE = " overlay ";
    assert.equal(isOverlayRenderModeEnabled(), true, "whitespace trimmed → true");
  } finally {
    if (prior === undefined) delete process.env.DAHLIA_RENDER_MODE;
    else process.env.DAHLIA_RENDER_MODE = prior;
  }
});

test("buildTextFreeScenePrompt: carries the ZERO-added-text hard rule (the whole point of the overlay path)", () => {
  const prompt = buildTextFreeScenePrompt(brief(), true, true);
  assert.ok(/TEXT-FREE \(hard rule/.test(prompt), "sentinel present");
  assert.ok(/absolutely ZERO added text/.test(prompt), "explicit zero-text rule");
  assert.ok(/CINNAMON LATTE/.test(prompt), "names the concrete flavor-caption failure mode from the reference");
  assert.ok(/no watermark/.test(prompt), "no watermark clause");
});

test("buildTextFreeScenePrompt: on the imitation path the FIRST image is the proven competitor reference (reuse composition, swap product)", () => {
  const prompt = buildTextFreeScenePrompt(brief(), true, true);
  assert.ok(/FIRST image is a PROVEN, high-performing competitor ad/.test(prompt));
  assert.ok(/REUSE ITS WINNING COMPOSITION/.test(prompt));
  assert.ok(/REPLACE its product with OUR product/.test(prompt));
});

test("buildTextFreeScenePrompt: enforces Part 2 QC rules — real variant, re-light, keep pack in frame, no third-party brands", () => {
  const prompt = buildTextFreeScenePrompt(brief(), true, true);
  assert.ok(/OUR flavor's REAL variant/.test(prompt), "swap product/drink/props to real variant image");
  assert.ok(/RE-LIGHT the product to match the scene/.test(prompt), "re-light rule");
  assert.ok(/FULLY IN FRAME/.test(prompt), "keep pack fully in frame");
  assert.ok(/NO THIRD-PARTY BRANDS/.test(prompt), "no third-party brands hard rule");
});

test("buildTextFreeScenePrompt: without a design reference falls back to a clean own-brand scene clause", () => {
  const prompt = buildTextFreeScenePrompt(brief(), false, false);
  assert.ok(!/FIRST image is a PROVEN/.test(prompt), "no imitation clause without a ref");
  assert.ok(/Clean, premium direct-response e-commerce scene/.test(prompt));
  // The ZERO-text rule still applies — it's what makes this the overlay path at all.
  assert.ok(/absolutely ZERO added text/.test(prompt));
});
