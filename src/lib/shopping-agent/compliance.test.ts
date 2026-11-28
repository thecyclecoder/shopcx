/**
 * Unit tests for the AI shopping-agent compliance module (src/lib/shopping-agent/compliance.ts).
 *
 * Covers EVERY block + allow case named in the spec's Phase 2 guardrail rules: disease/condition
 * terms, drug comparisons, weight-loss quantification + guarantee/hype phrases, allowed
 * structure/function framing, the disclaimer exemption, quote dropping (whole, never rewritten),
 * generated-sentence dropping + counting, and the input-side safety gate.
 *
 * Run:  npx tsx --test src/lib/shopping-agent/compliance.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkClaim,
  filterText,
  filterQuotes,
  evaluateSafetyGate,
  MANDATORY_DISCLAIMER,
} from "./compliance";

test("disease / condition terms → block", () => {
  for (const s of [
    "This will cure your diabetes",
    "helps treat high blood pressure",
    "reverses insulin resistance",
    "great for IBS and acid reflux",
    "prevents cancer",
    "lowers cholesterol",
    "manages your thyroid",
  ]) {
    const r = checkClaim(s);
    assert.equal(r.ok, false, `expected block: ${s}`);
    assert.equal(r.category, "disease");
  }
});

test("drug comparisons → block", () => {
  for (const s of [
    "works like Ozempic",
    "a natural GLP-1 alternative",
    "better than semaglutide",
    "use it instead of medication",
    "works like a prescription",
    "compare to Mounjaro",
  ]) {
    const r = checkClaim(s);
    assert.equal(r.ok, false, `expected block: ${s}`);
    assert.equal(r.category, "drug_comparison");
  }
});

test("weight-loss quantification → block", () => {
  for (const s of [
    "I lost 20 lbs in a month",
    "down 3 dress sizes",
    "dropped 15 pounds fast",
    "lost two sizes already",
    // Live misses found 2026-11-28 on Amazing Coffee reviews: "+" suffix and no-space units.
    "I lost 40+ pounds!",
    "I have lost 25lbs since I started drinking it.",
    "down 10kg",
    "I have lost few pounds while using this product.",
  ]) {
    const r = checkClaim(s);
    assert.equal(r.ok, false, `expected block: ${s}`);
    assert.equal(r.category, "weight_loss");
  }
});

test("weight-loss guarantee / hype phrases → block", () => {
  for (const s of [
    "guaranteed results",
    "melt fat overnight",
    "this fat burner works",
    "detox your body",
    "flush toxins out",
    "a miracle supplement",
    "100% results",
  ]) {
    const r = checkClaim(s);
    assert.equal(r.ok, false, `expected block: ${s}`);
    assert.equal(r.category, "weight_loss");
  }
});

test("allowed structure/function + experience framing → allow", () => {
  for (const s of [
    "supports healthy energy levels",
    "helps with occasional bloating",
    "customers say it helps curb cravings",
    "many reported feeling fuller between meals",
    "gives me steady energy through the afternoon",
    "an easy daily habit I can stick with",
  ]) {
    assert.equal(checkClaim(s).ok, true, `expected allow: ${s}`);
  }
});

test("a bare number without a weight verb is allowed (no false positive)", () => {
  assert.equal(checkClaim("Each tin has 30 servings").ok, true);
  assert.equal(checkClaim("Take 2 tabs daily").ok, true);
});

test("mandatory disclaimer is exempt from the block list", () => {
  // It literally contains "treat, cure, or prevent" + "disease" — must still pass.
  assert.equal(checkClaim(MANDATORY_DISCLAIMER).ok, true);
});

test("filterQuotes drops a blocked quote whole and counts it", () => {
  const quotes = [
    { verbatim_phrase: "I have way more steady energy now", id: "a" },
    { verbatim_phrase: "It cured my diabetes", id: "b" },
    { verbatim_phrase: "lost 25 lbs", id: "c" },
  ];
  const { kept, droppedCount } = filterQuotes(quotes);
  assert.equal(droppedCount, 2);
  assert.deepEqual(kept.map((q) => q.id), ["a"]);
});

test("filterText drops a blocked sentence, keeps compliant ones, counts drops", () => {
  const input = "Customers say it helps curb cravings. It cures diabetes. It supports steady energy.";
  const { text, droppedCount } = filterText(input);
  assert.equal(droppedCount, 1);
  assert.ok(text.includes("curb cravings"));
  assert.ok(text.includes("steady energy"));
  assert.ok(!/cures diabetes/i.test(text));
});

test("safety gate trips on pregnancy / medication / under-18 / medical condition", () => {
  for (const s of [
    "I am pregnant, is this safe?",
    "I'm breastfeeding my newborn",
    "I take medication for my heart",
    "on a prescription right now",
    "my son is under 18",
    "I have a medical condition",
  ]) {
    assert.equal(evaluateSafetyGate(s).triggered, true, `expected gate: ${s}`);
  }
});

test("safety gate trips on a block-list disease term in the shopper's words", () => {
  const r = evaluateSafetyGate("I was just diagnosed with diabetes");
  assert.equal(r.triggered, true);
});

test("safety gate does NOT trip on an ordinary situation", () => {
  assert.equal(evaluateSafetyGate("I keep getting an afternoon energy slump at work").triggered, false);
  assert.equal(evaluateSafetyGate("I want to swap my morning coffee for something gentler").triggered, false);
});
