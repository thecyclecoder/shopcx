/**
 * debrand tests — pin the Phase 1 rules of
 * [[../../../docs/brain/specs/dahlia-preserve-competitor-copy-dna-debranded.md]]:
 *   npx tsx --test src/lib/ads/debrand.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseGroundedSubstitute,
  debrandForOurBrand,
  isCompetitorOffer,
  stripCompetitorOffer,
} from "./debrand";

test("(a) 'MUD/WTR vs Ryze' with competitorAdvertiser='MUD/WTR' → 'vs Ryze' (brand slash-name stripped)", () => {
  assert.equal(
    debrandForOurBrand("MUD/WTR vs Ryze", "MUD/WTR", "Superfoods Company"),
    "vs Ryze",
  );
});

test("(b) 'Ryze Mushroom Coffee is better' with competitorAdvertiser='Ryze' → 'Mushroom Coffee is better' ('coffee' allowlist keeps the benign token untouched — only present in text, but the advertiser tokens themselves are also allowlisted so a 'Ryze Coffee' advertiser wouldn't over-strip)", () => {
  assert.equal(
    debrandForOurBrand("Ryze Mushroom Coffee is better", "Ryze", "Superfoods Company"),
    "Mushroom Coffee is better",
  );
});

test("(c) null competitorAdvertiser → input unchanged", () => {
  assert.equal(
    debrandForOurBrand("Ryze Mushroom Coffee is better", null, "Superfoods Company"),
    "Ryze Mushroom Coffee is better",
  );
});

test("(d) case-insensitivity: lower-case 'ryze' in text is stripped when advertiser is 'Ryze'", () => {
  assert.equal(
    debrandForOurBrand("ryze mushroom coffee is better", "Ryze", "Superfoods Company"),
    "mushroom coffee is better",
  );
});

test("(e) empty text is returned unchanged (null-safe)", () => {
  assert.equal(debrandForOurBrand("", "Ryze", "Superfoods Company"), "");
});

test("(f) product-name allowlist prevents over-strip: advertiser 'Ryze Coffee' does not strip 'coffee' from the text — only 'Ryze' is stripped", () => {
  assert.equal(
    debrandForOurBrand("Ryze Coffee is smoother than the rest", "Ryze Coffee", "Superfoods Company"),
    "Coffee is smoother than the rest",
  );
});

test("(g) possessive suffix on a stripped token is also removed ('Ryze's mushroom blend' → 'mushroom blend')", () => {
  assert.equal(
    debrandForOurBrand("Ryze's mushroom blend", "Ryze", "Superfoods Company"),
    "mushroom blend",
  );
});

test("(h) whole-word boundary — advertiser 'RYZ' does NOT strip 'ryzen' (would be a partial hit)", () => {
  assert.equal(
    debrandForOurBrand("The ryzen platform is fast", "RYZ", "Superfoods Company"),
    "The ryzen platform is fast",
  );
});

test("(i) tokens shorter than 3 chars in advertiser are ignored (a 2-char 'IO' would risk stripping IO from IO-Zen; only ≥3-char tokens participate)", () => {
  assert.equal(
    debrandForOurBrand("IO-Zen is a great blend", "IO Zen", "Superfoods Company"),
    "IO- is a great blend",
  );
});

// ── Phase 1 — offer swap (swap-competitor-offer-slot-for-our-grounded-proof-benefit-or-feature-in-debrand) ─
// A competitor's offer slot is an OFFER we do not run (free tote / free gift / bonus item /
// discount). Carried through the debrand into Dahlia's imitation rubric it fails every downstream
// gate. Detect + swap upstream so the winning STRUCTURE survives but the promise becomes grounded.

test("isCompetitorOffer — 'Free tote with every order' matches (freebie phrasing)", () => {
  assert.equal(isCompetitorOffer("Free tote with every order"), true);
});

test("isCompetitorOffer — 'Free gift with purchase' matches (freebie phrasing)", () => {
  assert.equal(isCompetitorOffer("Free gift with purchase"), true);
});

test("isCompetitorOffer — '50% OFF today' matches (percent-off discount)", () => {
  assert.equal(isCompetitorOffer("50% OFF today"), true);
});

test("isCompetitorOffer — 'Free shipping on every order' matches", () => {
  assert.equal(isCompetitorOffer("Free shipping on every order"), true);
});

test("isCompetitorOffer — 'BOGO this week' matches", () => {
  assert.equal(isCompetitorOffer("BOGO this week"), true);
});

test("isCompetitorOffer — a plain benefit ('Reduce bloating, support metabolism') does NOT match", () => {
  assert.equal(isCompetitorOffer("Reduce bloating, support metabolism"), false);
});

test("isCompetitorOffer — a proof point ('700,000+ customers · Non-GMO · 3rd-party tested') does NOT match", () => {
  assert.equal(isCompetitorOffer("700,000+ customers · Non-GMO · 3rd-party tested"), false);
});

test("isCompetitorOffer — null / empty / undefined return false (null-safe)", () => {
  assert.equal(isCompetitorOffer(null), false);
  assert.equal(isCompetitorOffer(undefined), false);
  assert.equal(isCompetitorOffer(""), false);
});

test("stripCompetitorOffer — 'Free tote badge with product held up outdoors' → structural words preserved", () => {
  // The 'free tote' phrase is scrubbed; the WINNING STRUCTURE ('with product held up outdoors')
  // survives so a hook a competitor ran for 45+ paid days can still be imitated.
  const out = stripCompetitorOffer("Free tote badge with product held up outdoors");
  assert.equal(/tote/i.test(out), false);
  assert.equal(/free/i.test(out), false);
  assert.equal(out.includes("with product held up outdoors"), true);
});

test("stripCompetitorOffer — 'Save 40% today, taste you'll love' → discount stripped, benefit survives", () => {
  const out = stripCompetitorOffer("Save 40% today, taste you'll love");
  assert.equal(/40\s*%/i.test(out), false);
  assert.equal(/save/i.test(out), false);
  assert.equal(out.includes("taste you'll love"), true);
});

test("chooseGroundedSubstitute — a Superfood Tabs brief yields a proofStack point (not 'tote')", () => {
  const brief = {
    proofStack: ["700,000+ customers", "Non-GMO", "3rd-party tested"],
    supportingBenefits: ["no crash", "great taste"],
    leadProof: { text: "reduce bloating, support metabolism, curb cravings" },
    productFeatures: ["15 superfoods per tab"],
  };
  const sub = chooseGroundedSubstitute(brief);
  assert.equal(sub, "700,000+ customers");
  assert.equal(/tote/i.test(sub ?? ""), false);
});

test("chooseGroundedSubstitute — falls back to supportingBenefits when proofStack is empty", () => {
  const brief = {
    proofStack: [],
    supportingBenefits: ["no crash", "great taste"],
    leadProof: { text: "curb cravings" },
    productFeatures: ["15 superfoods per tab"],
  };
  assert.equal(chooseGroundedSubstitute(brief), "no crash");
});

test("chooseGroundedSubstitute — falls back to leadProof.text when proofStack + benefits empty", () => {
  const brief = {
    proofStack: null,
    supportingBenefits: null,
    leadProof: { text: "curb cravings" },
    productFeatures: ["15 superfoods per tab"],
  };
  assert.equal(chooseGroundedSubstitute(brief), "curb cravings");
});

test("chooseGroundedSubstitute — falls back to productFeatures when everything else missing (derived feature: '15 superfoods per tab')", () => {
  const brief = {
    proofStack: null,
    supportingBenefits: null,
    leadProof: null,
    productFeatures: ["15 superfoods per tab", "fizz and drink"],
  };
  assert.equal(chooseGroundedSubstitute(brief), "15 superfoods per tab");
});

test("chooseGroundedSubstitute — returns null when the brief carries no grounded selling point", () => {
  assert.equal(chooseGroundedSubstitute({}), null);
  assert.equal(
    chooseGroundedSubstitute({ proofStack: [], supportingBenefits: [], leadProof: null, productFeatures: [] }),
    null,
  );
  assert.equal(
    chooseGroundedSubstitute({ proofStack: ["  "], supportingBenefits: [""], leadProof: { text: null } }),
    null,
  );
});
