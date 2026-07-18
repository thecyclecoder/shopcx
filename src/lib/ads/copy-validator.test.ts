/**
 * copy-validator tests — pins the six deterministic rails validateGeneratedCopy rolls up. Each
 * case starts from an all-green baseline copy and mutates ONE field to prove that ONE rail flips
 * to fail while the others still pass. This is the SSOT the M1 keystone author + Max QC will
 * both read in Phase 2, so drift here would let one consumer flag a rail the other silently
 * skips — the exact failure mode the M2 spec is preventing.
 *
 * Runs via: npx tsx --test src/lib/ads/copy-validator.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateGeneratedCopy, type ValidatorContext } from "./copy-validator";
import { META_CAPS } from "../ad-tool-config";
import { validateCopyParagraphStructure } from "./creative-agent";
import type { CreativeBrief } from "./creative-brief";

// Minimal brief stub — Phase 1's validator does not read `brief`; it's threaded through so
// Phase 2's call sites don't have to change signature. We keep the object typed via `as` so
// this test file doesn't have to reconstruct the full ProductIntelligence graph.
const stubBrief = { productTitle: "Amazing Coffee" } as unknown as CreativeBrief;

const baseContext: ValidatorContext = {
  audience_temperature: "warm",
  competitorAdvertisers: [],
  ourBrand: "Amazing Coffee",
};

/** Baseline copy — carries an LF8 keyword, fits every META cap, no bare MSRP, no competitor
 *  leak, no cold-audience concern (warm), a single promise. All six rails green. */
const goodCopy = {
  headline: "Cleaner morning energy",
  primaryText: "Drink one cup and get through the afternoon without the crash.",
  description: "Real reviews from customers who switched.",
};

test("(a) baseline copy passes all six rails", () => {
  const r = validateGeneratedCopy(goodCopy, stubBrief, baseContext);
  assert.equal(r.pass, true, `expected pass; got ${JSON.stringify(r.checks.filter((c) => !c.pass))}`);
  const rails = r.checks.map((c) => c.rail);
  assert.deepEqual(rails, ["lf8", "meta_caps", "no_msrp", "no_competitor_leak", "cold_offer_gate", "single_promise"]);
});

test("(b) headline > META_CAPS.headline → meta_caps fails", () => {
  // Build a headline definitively longer than the cap, and still LF8-carrying so the lf8 rail passes.
  const longHeadline = "energy ".repeat(META_CAPS.headline).trim(); // > 40 chars
  assert.ok(longHeadline.length > META_CAPS.headline);
  const r = validateGeneratedCopy({ ...goodCopy, headline: longHeadline }, stubBrief, baseContext);
  assert.equal(r.pass, false);
  const metaCap = r.checks.find((c) => c.rail === "meta_caps")!;
  assert.equal(metaCap.pass, false);
  assert.match(metaCap.reason ?? "", /headline/);
});

test("(c) primaryText carries '$29' with no strikethrough → no_msrp fails", () => {
  const r = validateGeneratedCopy(
    { ...goodCopy, primaryText: "Only $29 today — get yours before we sell out." },
    stubBrief,
    baseContext,
  );
  const msrp = r.checks.find((c) => c.rail === "no_msrp")!;
  assert.equal(msrp.pass, false, `expected no_msrp fail; got ${JSON.stringify(r.checks)}`);
  assert.equal(msrp.evidence, "$29");
});

test("no_msrp: '~~$29~~' strikethrough is allowed", () => {
  const r = validateGeneratedCopy(
    { ...goodCopy, primaryText: "Was ~~$29~~ now delicious every morning." },
    stubBrief,
    baseContext,
  );
  const msrp = r.checks.find((c) => c.rail === "no_msrp")!;
  assert.equal(msrp.pass, true);
});

test("no_msrp: '$1 per serving' is allowed (per-unit phrasing)", () => {
  const r = validateGeneratedCopy(
    { ...goodCopy, primaryText: "$1 per serving — cleaner morning energy without the crash." },
    stubBrief,
    baseContext,
  );
  const msrp = r.checks.find((c) => c.rail === "no_msrp")!;
  assert.equal(msrp.pass, true);
});

test("(d) primaryText carries 'MUD/WTR' with competitorAdvertisers=['MUD/WTR'] → no_competitor_leak fails", () => {
  const r = validateGeneratedCopy(
    { ...goodCopy, primaryText: "Cleaner than MUD/WTR — and half the caffeine crash." },
    stubBrief,
    { ...baseContext, competitorAdvertisers: ["MUD/WTR"] },
  );
  const leak = r.checks.find((c) => c.rail === "no_competitor_leak")!;
  assert.equal(leak.pass, false, `expected competitor leak; got ${JSON.stringify(r.checks)}`);
  assert.match(leak.evidence ?? "", /MUD\/WTR/i);
});

test("no_competitor_leak: allowlisted product-name token ('coffee') never counts as a leak", () => {
  // "coffee" is inside the PRODUCT_NAME_ALLOWLIST debrand shares — a competitor named "Ritual Coffee"
  // must not flag on the word "coffee".
  const r = validateGeneratedCopy(
    { ...goodCopy, primaryText: "Cleaner morning coffee without the crash." },
    stubBrief,
    { ...baseContext, competitorAdvertisers: ["Ritual Coffee"] },
  );
  const leak = r.checks.find((c) => c.rail === "no_competitor_leak")!;
  assert.equal(leak.pass, true, `allowlist token should not leak; got ${JSON.stringify(leak)}`);
});

test("(e) audience_temperature='cold' + primaryText carries 'save 25%' → cold_offer_gate fails", () => {
  const r = validateGeneratedCopy(
    { ...goodCopy, primaryText: "Save 25% today — cleaner morning energy from a proven cup." },
    stubBrief,
    { ...baseContext, audience_temperature: "cold" },
  );
  const gate = r.checks.find((c) => c.rail === "cold_offer_gate")!;
  assert.equal(gate.pass, false, `expected cold gate fail; got ${JSON.stringify(r.checks)}`);
});

test("cold_offer_gate: warm audience + the same offer copy passes (gate is temperature-scoped)", () => {
  const r = validateGeneratedCopy(
    { ...goodCopy, primaryText: "Save 25% today — cleaner morning energy from a proven cup." },
    stubBrief,
    { ...baseContext, audience_temperature: "warm" },
  );
  const gate = r.checks.find((c) => c.rail === "cold_offer_gate")!;
  assert.equal(gate.pass, true);
});

test("(f) 'lose 40 lbs and boost energy and clear brain fog' → single_promise fails", () => {
  const r = validateGeneratedCopy(
    {
      headline: "Lose 40 lbs and boost energy",
      primaryText: "Lose 40 lbs and boost energy and clear brain fog with one delicious cup.",
      description: "Real reviews from customers.",
    },
    stubBrief,
    baseContext,
  );
  const promise = r.checks.find((c) => c.rail === "single_promise")!;
  assert.equal(promise.pass, false, `expected single_promise fail; got ${JSON.stringify(r.checks)}`);
});

test("single_promise: one clean promise passes", () => {
  const r = validateGeneratedCopy(
    {
      headline: "Cleaner morning energy",
      primaryText: "Boost focus with one cup — delicious every morning.",
      description: "Real reviews from customers.",
    },
    stubBrief,
    baseContext,
  );
  const promise = r.checks.find((c) => c.rail === "single_promise")!;
  assert.equal(promise.pass, true);
});

test("lf8: copy with no LF8 keyword in headline+primary → lf8 fails", () => {
  // No LF8 token anywhere in headline+primaryText — pure feature-dump vocab.
  const r = validateGeneratedCopy(
    { headline: "Adaptogenic blend", primaryText: "Chaga plus cordyceps in a pouch.", description: "Try the pouch." },
    stubBrief,
    baseContext,
  );
  const lf8 = r.checks.find((c) => c.rail === "lf8")!;
  assert.equal(lf8.pass, false, `expected lf8 fail; got ${JSON.stringify(r.checks)}`);
});

test("rail order is fixed (lf8 → meta_caps → no_msrp → no_competitor_leak → cold_offer_gate → single_promise)", () => {
  const r = validateGeneratedCopy(goodCopy, stubBrief, baseContext);
  assert.deepEqual(
    r.checks.map((c) => c.rail),
    ["lf8", "meta_caps", "no_msrp", "no_competitor_leak", "cold_offer_gate", "single_promise"],
  );
});

test("pass = every check passes", () => {
  const r = validateGeneratedCopy(
    { ...goodCopy, primaryText: "$29 today — no strikethrough." },
    stubBrief,
    baseContext,
  );
  assert.equal(r.pass, false);
  assert.equal(
    r.pass,
    r.checks.every((c) => c.pass),
  );
});

// reconcile-long-form-3-paragraph-primary-text-with-meta-primary-text-cap Phase 1 —
// a representative long-form 3-paragraph primary (hook + 2-3x body + close) must pass BOTH
// `validateGeneratedCopy` (meta_caps rail) AND `validateCopyParagraphStructure`. Prior to raising
// META_CAPS.primary_text 600 → 1200 the two rails were mutually unsatisfiable on some angles, and
// Dahlia's revise loop exhausted with `validator_failed: meta_caps`. Locks the coexistence so a
// future cap change cannot silently re-break long-form.
test("long-form 3-paragraph primary passes BOTH meta_caps AND validateCopyParagraphStructure", () => {
  const longFormPrimary = [
    // hook (~25 words): short, curiosity-shaped, front-loaded above the fold.
    "I quit coffee for 30 days and my afternoon crash disappeared. What replaced it might be the best-kept energy secret of the last decade of nutrition research.",
    // body (~110 words, ≥2x the hook): the info + proof stack, still human-voiced.
    "Ashwagandha, cordyceps, and lion's mane give you steady, jitter-free morning energy — the kind that carries through 4pm without the coffee shakes. Real customers switched and stopped reaching for a second cup by lunch. One buyer wrote in that her focus at work sharpened within a week and she stopped needing the mid-afternoon nap she'd relied on for years. The blend is third-party tested for purity, USDA Organic certified, and delivered fresh from a family-owned farm. Every batch carries the same standardized adaptogen dose, so you know exactly what you're drinking. No fillers, no sugar, no crash. Just one clean cup that keeps you sharp from breakfast through the evening walk.",
    // close (~18 words, ≤ PARAGRAPH_CLOSE_MAX_WORDS): one-sentence curiosity nudge.
    "See why more than 40,000 people started their morning differently — and never went back to what they were drinking before.",
  ].join("\n\n");
  // A representative long-form primary sits comfortably above the old 600 cap and comfortably under
  // the new 1200 cap — this is the whole point of the reconcile.
  assert.ok(longFormPrimary.length > 600, `long-form primary length ${longFormPrimary.length} should exceed the old 600 cap`);
  assert.ok(longFormPrimary.length <= META_CAPS.primary_text, `long-form primary length ${longFormPrimary.length} should fit within META_CAPS.primary_text ${META_CAPS.primary_text}`);
  const paragraph = validateCopyParagraphStructure(longFormPrimary);
  assert.equal(paragraph.ok, true, `expected paragraph structure ok; got ${JSON.stringify(paragraph)}`);
  const r = validateGeneratedCopy(
    { ...goodCopy, primaryText: longFormPrimary },
    stubBrief,
    baseContext,
  );
  const metaCap = r.checks.find((c) => c.rail === "meta_caps")!;
  assert.equal(metaCap.pass, true, `expected meta_caps pass on long-form primary; got ${JSON.stringify(metaCap)}`);
  assert.equal(r.pass, true, `expected all rails pass; got ${JSON.stringify(r.checks.filter((c) => !c.pass))}`);
});

test("runaway ~3000-char primary still fails meta_caps (cap remains a real ceiling)", () => {
  // A genuinely runaway primary must still be rejected — the 1200 cap is a widening for long-form,
  // not a removal. Keeps the rail's ceiling meaningful.
  const runaway = "energy proven focus calm ".repeat(200); // ~5000 chars, definitely > 1200
  assert.ok(runaway.length > META_CAPS.primary_text);
  const r = validateGeneratedCopy(
    { ...goodCopy, primaryText: runaway },
    stubBrief,
    baseContext,
  );
  const metaCap = r.checks.find((c) => c.rail === "meta_caps")!;
  assert.equal(metaCap.pass, false, `expected meta_caps fail on runaway primary; got ${JSON.stringify(metaCap)}`);
  assert.match(metaCap.reason ?? "", /primary text/);
});
