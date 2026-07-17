/**
 * Unit tests for buildPrompt's CLAIM FIDELITY guard — a competitor imitation must NOT carry over a
 * product attribute that is false of OUR product (the 2026-07-17 "protein coffee" leak: Amazing
 * Coffee has no protein, but the imitated competitor angle was a protein-coffee ad and the word
 * rendered onto one placement).
 *
 *   npx tsx --test src/lib/ads/creative-generate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { CreativeBrief } from "@/lib/ads/creative-brief";
import { buildPrompt } from "./creative-generate";

function brief(hook: string): CreativeBrief {
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

function briefWithReview(hook: string): CreativeBrief {
  const b = brief(hook) as unknown as { leadProof: unknown };
  b.leadProof = { kind: "review", text: "This coffee changed my mornings — so much focus.", attribution: "Jamie R." };
  return b as unknown as CreativeBrief;
}

test("buildPrompt: REVIEW FIDELITY forbids the competitor's review and, with OUR review provided, renders only ours (condensing allowed)", () => {
  const { prompt } = buildPrompt(briefWithReview("New daily superfood coffee."), true, undefined, true);
  assert.ok(prompt.includes("REVIEW FIDELITY"), "must carry the REVIEW FIDELITY hard rule");
  assert.ok(/NEVER copy, echo, paraphrase, or render the competitor's review/.test(prompt));
  assert.ok(/Render ONLY the customer review provided above/.test(prompt), "with our review provided, render only ours");
  assert.ok(/tighten a long review|faithful condensation/.test(prompt), "summarizing the best parts of a long review is allowed");
  assert.ok(/keep the reviewer NAME exactly/.test(prompt), "reviewer name stays real");
});

test("buildPrompt: REVIEW FIDELITY renders NO review when we don't provide one (never invent / carry over the competitor's)", () => {
  const { prompt } = buildPrompt(brief("New daily superfood coffee."), true, undefined, true);
  assert.ok(prompt.includes("REVIEW FIDELITY"));
  assert.ok(/render NO customer review, testimonial, quote, reviewer name, or star-rating/.test(prompt));
});

test("buildPrompt: an imitation carries a CLAIM FIDELITY rule forbidding false product attributes", () => {
  const { prompt } = buildPrompt(brief("New daily protein coffee."), true, undefined, true);
  assert.ok(prompt.includes("CLAIM FIDELITY"), "imitation prompt must include the CLAIM FIDELITY hard rule");
  assert.ok(/protein/.test(prompt), "the rule names the concrete failure mode (protein/keto/collagen)");
  assert.ok(/must be TRUE of Amazing Coffee/.test(prompt), "the rule anchors to OUR product's real attributes");
});

test("buildPrompt: the imitation HEADLINE clause tells the model to DROP a non-true competitor attribute", () => {
  const { prompt } = buildPrompt(brief("New daily protein coffee."), true, undefined, true);
  assert.ok(/DROP any product ATTRIBUTE or ingredient descriptor/.test(prompt));
  assert.ok(/SWAP IN OURS/.test(prompt), "when the competitor's product noun differs, swap in ours");
});

test("buildPrompt: an own-brand angle renders its headline exactly and needs no attribute swap", () => {
  const { prompt, expectedCopy } = buildPrompt(brief("The #1 superfood coffee"), true, undefined, false);
  assert.equal(expectedCopy.headline, "The #1 superfood coffee", "own-brand asserts its exact hook");
  assert.ok(/render EXACTLY/.test(prompt));
});
