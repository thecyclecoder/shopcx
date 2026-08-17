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
import { buildPrompt, SOURCE_STRUCTURE_HEADER } from "./creative-generate";
import type { SkeletonElement } from "@/lib/ads/decision-engine";

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

// NOTE (2026-08-17): the three assertions below were rewritten to match the TRUTH-TEST headline
// clause that replaced the old blanket "DROP any …" wording. The rule inverted deliberately —
// CEO: "we can echo words if the words apply to our product cleanly" — so the contract is now
// KEEP-unless-untrue, not drop-on-sight. The tests kept asserting the retired strings and had been
// red on main since that rewrite; they now pin the behaviour that actually ships.
test("buildPrompt: the imitation HEADLINE clause swaps a competitor attribute that is NOT true of our product", () => {
  const { prompt } = buildPrompt(brief("New daily protein coffee."), true, undefined, true);
  assert.ok(/ATTRIBUTE \/ ingredient descriptor/.test(prompt), "the truth test covers product attributes");
  assert.ok(/swap in our real equivalent only when it is not/.test(prompt), "swap ONLY when the attribute is untrue of us");
  assert.ok(/protein coffee/.test(prompt), "names the concrete 2026-07-17 failure mode");
});

test("buildPrompt: an own-brand angle renders its headline exactly and needs no attribute swap", () => {
  const { prompt, expectedCopy } = buildPrompt(brief("The #1 superfood coffee"), true, undefined, false);
  assert.equal(expectedCopy.headline, "The #1 superfood coffee", "own-brand asserts its exact hook");
  assert.ok(/render EXACTLY/.test(prompt));
});

// ── debrand hardening 2026-07-19 — drop mismatched benefits + unverified claims + no third-party brands

test("buildPrompt: the imitation HEADLINE clause keeps a BENEFIT we deliver and drops one we don't", () => {
  const { prompt } = buildPrompt(brief("Deeper Sleep, Clear Mornings"), true, undefined, true);
  assert.ok(/BENEFIT \/ RESULT \/ PROMISE/.test(prompt), "the truth test covers benefits, not just attributes");
  assert.ok(/drop it only when we do not deliver it/.test(prompt), "a benefit is dropped ONLY when untrue of us");
  assert.ok(
    /Do not discard a benefit merely because a competitor used the phrase/.test(prompt),
    "echoing a competitor's wording is explicitly allowed when the benefit is real (CEO 2026-08-17)",
  );
});

test("buildPrompt: the imitation HEADLINE clause forbids carrying a competitor's specific unverified claim / timeframe (fabrication)", () => {
  const { prompt } = buildPrompt(brief("10 Weeks to Younger-Looking Skin"), true, undefined, true);
  assert.ok(/SPECIFIC NUMBER, TIMEFRAME OR PERCENTAGE/.test(prompt), "numbers get their own truth-test rung");
  assert.ok(/keep ONLY when it is a verified fact/.test(prompt), "a number survives only if verified about OUR product");
  assert.ok(/is a FABRICATION, not an imitation/.test(prompt));
});

test("buildPrompt: a competitor imitation carries a NO THIRD-PARTY BRANDS rule (no Red Bull/Monster in a before-frame)", () => {
  const { prompt } = buildPrompt(brief("Ditch the 3pm crash"), true, undefined, true);
  assert.ok(prompt.includes("NO THIRD-PARTY BRANDS"), "imitation prompt must carry the no-third-party-brand hard rule");
  assert.ok(/Red Bull/.test(prompt) && /Monster/.test(prompt), "names the concrete brands that leaked");
  assert.ok(/before.?frame|before.?state|before/i.test(prompt), "covers a staged before-state prop");
});

// ── dahlia-imitates-the-pinned-ad-structure-instead-of-redesigning-it Phase 3 ────────────────

test("buildPrompt: sourceWireframe absent → no SOURCE STRUCTURE clause (byte-identical to today)", () => {
  const { prompt } = buildPrompt(brief("New daily superfood coffee"), true, undefined, true);
  assert.ok(!prompt.includes(SOURCE_STRUCTURE_HEADER), "no source wireframe = no clause");
});

test("buildPrompt: sourceWireframe lands the binding SOURCE STRUCTURE clause IMMEDIATELY after refClause", () => {
  const elements: SkeletonElement[] = [
    { zone: "header", role: "hook", prominence: 9 },
    { zone: "hero", role: "mechanism", prominence: 8 },
    { zone: "footer", role: "offer", prominence: 6 },
  ];
  const { prompt } = buildPrompt(
    brief("Ditch the 3pm crash"),
    true,
    undefined,
    true,
    undefined,
    { elements, productPresentation: ["packshot"], punchiness: ["short", "declarative"] },
  );
  const idxRef = prompt.indexOf("REUSE ITS WINNING COMPOSITION");
  const idxSource = prompt.indexOf(SOURCE_STRUCTURE_HEADER);
  assert.ok(idxRef >= 0, "refClause present on the imitation path");
  assert.ok(idxSource > idxRef, "SOURCE STRUCTURE lands AFTER refClause (earliest instructions weigh heaviest)");
  // Elements enumerated in reading order (header → hero → body → footer → cta), prominence in the label.
  assert.ok(/header · hook \(prominence 9\)/.test(prompt));
  assert.ok(/hero · mechanism \(prominence 8\)/.test(prompt));
  assert.ok(/footer · offer \(prominence 6\)/.test(prompt));
  const headerIdx = prompt.indexOf("header · hook");
  const heroIdx = prompt.indexOf("hero · mechanism");
  const footerIdx = prompt.indexOf("footer · offer");
  assert.ok(headerIdx < heroIdx && heroIdx < footerIdx, "elements listed in reading order");
  // Product presentation verbatim; punchiness verbatim.
  assert.ok(/PRODUCT PRESENTATION.*packshot/.test(prompt), "product presentation stated verbatim");
  assert.ok(/COPY RHYTHM.*short, declarative/.test(prompt), "copy rhythm stated verbatim from punchiness tags");
  // BINDING language + no-invent guard names the roles the source ad OMITS.
  assert.ok(/BINDING/.test(prompt), "phrased as binding, not decorative");
  assert.ok(/Do NOT invent any element type not in this list/.test(prompt));
  assert.ok(/proof \/ risk_reversal \/ social_proof \/ price/.test(prompt), "names the omitted roles the model must not invent");
});

test("buildPrompt: sourceWireframe with a `before_after` product presentation still emits STRUCTURE regardless of imitation flag", () => {
  const { prompt } = buildPrompt(
    brief("some hook"),
    false, // no design ref — still emit STRUCTURE when supplied
    undefined,
    false,
    undefined,
    { elements: [{ zone: "hero", role: "proof", prominence: 9 }], productPresentation: ["before_after"], punchiness: [] },
  );
  assert.ok(prompt.includes(SOURCE_STRUCTURE_HEADER), "wireframe clause fires whenever wireframe is supplied");
});

// ── CEO 2026-08-17 (#4) — OWNER PRECEDENCE over the angle hook ────────────────────────────────
// Job 58138929 authored under `angleHook: "Meet Nature's Ozempic"` (a Novo Nordisk trademark)
// although the owner's note pinned "Nature's Way To Curb Cravings" verbatim AND banned the word.
// The two clauses simply coexisted — `authorNotesClause` renders EARLIER than `headlineClause`, so
// the last instruction the model read was "ECHO <competitor hook>". Precedence is now STATED.
function briefWithOwnerNote(hook: string, note: string | null): CreativeBrief {
  const b = brief(hook) as unknown as { authorNotes: string | null };
  b.authorNotes = note;
  return b as unknown as CreativeBrief;
}

test("buildPrompt: an owner note outranks the competitor hook on the IMITATION path", () => {
  const { prompt } = buildPrompt(
    briefWithOwnerNote("Meet Nature's Ozempic", 'Use this EXACT headline: "Nature\'s Way To Curb Cravings". Do NOT use the word Ozempic.'),
    true,
    undefined,
    true,
  );
  assert.ok(/OWNER OVERRIDE, ABOVE EVEN RAIL 0/.test(prompt), "the headline clause must state owner precedence");
  assert.ok(/THAT is the headline/.test(prompt), "an owner-named headline wins outright");
  assert.ok(/must not appear anywhere in the image/.test(prompt), "an owner-banned word is banned even inside an echoed line");
});

test("buildPrompt: an owner note outranks the hook on the OWN-BRAND path too", () => {
  const { prompt } = buildPrompt(briefWithOwnerNote("Clean daily energy", "Lead with the sleep benefit instead."), false, undefined, false);
  assert.ok(/OWNER OVERRIDE/.test(prompt), "own-brand renders carry the same precedence clause");
});

test("buildPrompt: NO owner note ⇒ no precedence clause (the competitor hook stands unqualified)", () => {
  const { prompt } = buildPrompt(briefWithOwnerNote("Meet Nature's Ozempic", null), true, undefined, true);
  assert.ok(!/OWNER OVERRIDE/.test(prompt), "the clause must not appear when the owner left no directions");
  assert.ok(/RAIL 0/.test(prompt), "…but the standing trademark rail still applies");
});
