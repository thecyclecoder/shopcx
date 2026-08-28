/**
 * Tests for the Sol stock-promise gate.
 *
 * Anchored on the real incident (ticket 0c9f11a7, 2026-08-28): Sol offered "Superfood Tabs in
 * Mixed Berry and Strawberry Lemonade, plus Amazing Coffee in Hazelnut and Cocoa" while the 3PL
 * held zero Strawberry Lemonade. Registered as `test:sol-stock-promise-guard`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessSolStockPromiseRisk } from "./sol-stock-promise-guard";

const OOS = [{ product: "Superfood Tabs", variant: "Strawberry Lemonade" }];

test("BLOCKS the exact reply that caused the incident", () => {
  const r = assessSolStockPromiseRisk({
    firstReply:
      "Happy to help you reorder those, Keira — I've got your usual set right here: Superfood Tabs " +
      "in Mixed Berry and Strawberry Lemonade, plus Amazing Coffee in Hazelnut and Cocoa. No need " +
      "to hunt for them on the site — I can just place this for you.",
    outOfStock: OOS,
  });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.offendingVariants, ["Superfood Tabs / Strawberry Lemonade"]);
  assert.match(r.reason ?? "", /out-of-stock/);
});

test("PASSES a reply that names the flavour AS unavailable", () => {
  // This is the reply actually sent to the customer after the founder ruling — it must not block.
  const r = assessSolStockPromiseRisk({
    firstReply:
      "Strawberry Lemonade is out of stock right now, so I wasn't able to include it. I'm sending " +
      "you a Cocoa Amazing Coffee free of charge so you have the other flavor you were expecting.",
    outOfStock: OOS,
  });
  assert.equal(r.blocked, false);
  assert.equal(r.reason, null);
});

test("PASSES every other disclosure wording", () => {
  for (const phrasing of [
    "Strawberry Lemonade is sold out at the moment.",
    "We're temporarily out of Strawberry Lemonade.",
    "Strawberry Lemonade isn't available right now — I'll let you know when it's back in stock.",
    "I couldn't include the Strawberry Lemonade on this one.",
    "Strawberry Lemonade is currently out; would a second Cocoa work?",
  ]) {
    const r = assessSolStockPromiseRisk({ firstReply: phrasing, outOfStock: OOS });
    assert.equal(r.blocked, false, `should pass: ${phrasing}`);
  }
});

test("does not fire on in-stock flavours", () => {
  const r = assessSolStockPromiseRisk({
    firstReply: "I've set you up with Mixed Berry and Hazelnut — both on the way.",
    outOfStock: OOS,
  });
  assert.equal(r.blocked, false);
});

test("matches through HTML and hyphenation", () => {
  const r = assessSolStockPromiseRisk({
    firstReply: "<p>Your <b>Strawberry-Lemonade</b> is on its way!</p>",
    outOfStock: OOS,
  });
  assert.equal(r.blocked, true);
});

test("fails OPEN on empty inputs — the gate never invents a block", () => {
  assert.equal(assessSolStockPromiseRisk({ firstReply: "", outOfStock: OOS }).blocked, false);
  assert.equal(
    assessSolStockPromiseRisk({ firstReply: "Sending your Strawberry Lemonade!", outOfStock: [] }).blocked,
    false,
  );
});

test("ignores variant names too generic to match safely", () => {
  // A 3-char variant like "Ade" would collide with ordinary prose; require a real name.
  const r = assessSolStockPromiseRisk({
    firstReply: "Made your order already — it ships today.",
    outOfStock: [{ product: "Gummies", variant: "Ade" }],
  });
  assert.equal(r.blocked, false);
});

test("reports every offending variant, deduplicated", () => {
  const r = assessSolStockPromiseRisk({
    firstReply: "Sending Strawberry Lemonade and Peach Mango, plus more Strawberry Lemonade.",
    outOfStock: [
      { product: "Superfood Tabs", variant: "Strawberry Lemonade" },
      { product: "Superfood Tabs", variant: "Peach Mango" },
    ],
  });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.offendingVariants, [
    "Superfood Tabs / Strawberry Lemonade",
    "Superfood Tabs / Peach Mango",
  ]);
});
