import { test } from "node:test";
import assert from "node:assert/strict";
import { pitchContradictsRemedyType } from "./remedy-selector";

test("2026-10-20 ground truth: a skip pitch on a frequency remedy is caught", () => {
  assert.equal(
    pitchContradictsRemedyType("Skip your next order to clear that overstock, then pick back up when you're ready.", "frequency_change"),
    true,
  );
});

test("a pitch that matches its own type passes", () => {
  assert.equal(pitchContradictsRemedyType("Skip your next order so you can finish what you have.", "skip"), false);
  assert.equal(pitchContradictsRemedyType("Switch to every 2 months so it lines up with how fast you use it.", "frequency_change"), false);
  assert.equal(pitchContradictsRemedyType("Pause for 30 days and come back when you're ready.", "pause"), false);
  assert.equal(pitchContradictsRemedyType("Take 25% off your next three orders.", "coupon"), false);
});

test("a discount pitch on a pause remedy is caught", () => {
  assert.equal(pitchContradictsRemedyType("Get 20% off and keep your favorites coming.", "pause"), true);
});

test("a pause pitch on a skip remedy is caught", () => {
  assert.equal(pitchContradictsRemedyType("Pause your subscription for a bit.", "skip"), true);
});

test("non-billing remedies with neutral pitches pass", () => {
  assert.equal(pitchContradictsRemedyType("Here's what other customers said after sticking with it for three months.", "social_proof"), false);
  assert.equal(pitchContradictsRemedyType("Try a free bag of our new flavor on your next order.", "free_product"), false);
  assert.equal(pitchContradictsRemedyType("", "skip"), false);
});
