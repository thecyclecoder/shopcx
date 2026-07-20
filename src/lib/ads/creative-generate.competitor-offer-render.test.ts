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
import { AUTHOR_NOTES_HEADER, buildPrompt, renderPromptHasCompetitorOffer, stripCompetitorOfferArtifacts } from "./creative-generate";

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

test("renderPromptHasCompetitorOffer: an OWNER DIRECTIONS clause telling us to REMOVE a freebie does NOT false-trip (2026-07-20 Bloom→Amazing Creamer pinned run)", () => {
  const brief = competitorImitationBrief("Your skin doesn't need more serums");
  (brief as { authorNotes?: string | null }).authorNotes =
    "Remove the free tote badge and show a scoop of Amazing Creamer going into a hot latte";
  const { prompt } = buildPrompt(brief, true, undefined, true);
  // The owner's directions ARE composed into the prompt (so the model actually removes the tote)…
  assert.ok(/remove the free tote badge/i.test(prompt), "owner directions present in the composed prompt");
  // …but the guard excludes the trusted human clause, so it does not reject the whole generation.
  assert.equal(
    renderPromptHasCompetitorOffer(prompt),
    false,
    "an owner instruction that NAMES a freebie to remove must not trip the competitor-offer guard",
  );
});

test("renderPromptHasCompetitorOffer: a real freebie leak in the machine content STILL trips even with an owner clause present", () => {
  const p = `Design a 4:5 static ad. Get a free tote with every order.\n\n${AUTHOR_NOTES_HEADER} the owner asked for this ad. THE DIRECTIONS: "make it pop".\n\nOFFER FIDELITY (hard rule): only our real offer.`;
  assert.equal(renderPromptHasCompetitorOffer(p), true, "excluding the owner clause must not mask a genuine leak in the scanned content");
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
