/**
 * Render-side no-competitor-leak guard — pin the Phase 1 rules of
 * [[../../../docs/brain/specs/competitor-offer-leaks-into-feed-format-creative-image-extend-no-leak-gate-to-render.md]].
 *
 * The COPY-side no-competitor-leak gate only inspects text; a leak that lives in the pixels
 * (a competitor's 'free tote' offer graphic baked into the Feed 4:5 render) passed unseen.
 * These tests pin the RENDER-side extension: strip competitor offer artifacts out of the
 * composed prompt, negative-prompt them into the model instructions, and add a deterministic
 * guard that flags any lingering offer token in the composed prompt string so the regen loop
 * takes another shot instead of shipping the leak.
 *
 *   npx tsx --test src/lib/ads/creative-generate.competitor-offer-render.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { CreativeBrief } from "@/lib/ads/creative-brief";
import { buildPrompt, renderPromptHasCompetitorOffer, stripCompetitorOfferArtifacts } from "./creative-generate";

function competitorImitationBrief(hook: string): CreativeBrief {
  return {
    productTitle: "Amazing Coffee",
    angle: { hook, source: "competitor", leadBenefit: "clean daily energy", acquisitionPower: 8, retentionTruth: 7, commodity: false, hasRealPhoto: false, reasons: [] },
    leadProof: null,
    transformation: null,
    supportingBenefits: [],
    proofStack: ["Non-GMO", "3rd Party Tested"],
    offer: null,
    imageRefs: [],
    guardrails: [],
  } as unknown as CreativeBrief;
}

test("renderPromptHasCompetitorOffer flags a 'free tote' seeded prompt (the 2026-07-18 Feed leak token)", () => {
  assert.equal(renderPromptHasCompetitorOffer("Get a free tote with every subscription order"), true);
});

test("renderPromptHasCompetitorOffer flags every catalogued freebie artifact token", () => {
  assert.equal(renderPromptHasCompetitorOffer("plus a free gift with your order"), true);
  assert.equal(renderPromptHasCompetitorOffer("with a bonus item for early buyers"), true);
  assert.equal(renderPromptHasCompetitorOffer("with a bonus tote in every box"), true);
  assert.equal(renderPromptHasCompetitorOffer("gift with purchase"), true);
  assert.equal(renderPromptHasCompetitorOffer("GWP for VIPs"), true);
  assert.equal(renderPromptHasCompetitorOffer("enter our giveaway today"), true);
  assert.equal(renderPromptHasCompetitorOffer("free bag with every order"), true);
});

test("renderPromptHasCompetitorOffer passes a clean prompt (no false positives on ordinary product prose)", () => {
  assert.equal(renderPromptHasCompetitorOffer("Design a 4:5 static ad for Amazing Coffee. Clean, premium direct-response e-commerce static."), false);
});

test("stripCompetitorOfferArtifacts scrubs the offending tokens and returns clean prose", () => {
  const stripped = stripCompetitorOfferArtifacts("Try our blend — free tote with every order · giveaway inside");
  assert.equal(renderPromptHasCompetitorOffer(stripped), false, "the strip helper must produce a prompt the guard passes");
  assert.ok(!/free tote/i.test(stripped));
  assert.ok(!/giveaway/i.test(stripped));
});

test("buildPrompt: an imitation prompt strips a 'free tote' seeded into the competitor hook AND passes the render-side guard", () => {
  const { prompt } = buildPrompt(competitorImitationBrief("Get a free tote with your first order"), true, undefined, true);
  // The freebie token must be gone from the HEADLINE clause (the "the proven competitor
  // angle to ECHO is …" quote — the sole place the competitor hook is echoed into the
  // prompt as a POSITIVE directive). The prompt DOES still name the token in the negative
  // "NO COMPETITOR OFFER" rule (that is the point of a negative prompt), and the guard
  // scans the composed CONTENT above that rule and MUST pass.
  const headlineEchoMatch = /the proven competitor angle to ECHO is "([^"]+)"/i.exec(prompt);
  assert.ok(headlineEchoMatch, "the imitation prompt must echo the competitor angle in the HEADLINE clause");
  assert.ok(!/free tote/i.test(headlineEchoMatch[1]), "the freebie token must be stripped from the echoed competitor hook");
  assert.equal(renderPromptHasCompetitorOffer(prompt), false, "the composed imitation prompt must clear the render-side guard");
});

test("buildPrompt: an imitation carries a NO-COMPETITOR-OFFER negative-prompt clause naming the artifact tokens", () => {
  const { prompt } = buildPrompt(competitorImitationBrief("New daily superfood coffee"), true, undefined, true);
  assert.ok(/NO COMPETITOR OFFER|NO-COMPETITOR-OFFER|no competitor offer/i.test(prompt), "the imitation prompt names the guard by header");
  assert.ok(/tote/i.test(prompt), "the negative clause enumerates the tote artifact");
  assert.ok(/free gift/i.test(prompt), "the negative clause enumerates the free-gift artifact");
  assert.ok(/bonus/i.test(prompt), "the negative clause enumerates the bonus-item artifact");
  assert.ok(/giveaway/i.test(prompt), "the negative clause enumerates the giveaway artifact");
});
