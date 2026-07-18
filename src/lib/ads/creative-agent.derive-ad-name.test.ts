/**
 * deriveAdName tests — pin the Phase 1 rules of
 * [[../../../docs/brain/specs/dahlia-names-each-ad-from-its-headline-minus-weight-loss-not-a-generic-template.md]]:
 *   npx tsx --test src/lib/ads/creative-agent.derive-ad-name.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveAdName } from "./creative-agent";

test("weight-loss phrase is stripped from the derived name (case-insensitive)", () => {
  assert.equal(deriveAdName("Lose Weight Loss Fast", [], "Superfood Tabs"), "Lose Fast");
});

test("'weightloss' (no space) is stripped too", () => {
  assert.equal(deriveAdName("Weightloss made easy", [], "Superfood Tabs"), "made easy");
});

test("a clean headline passes through unchanged", () => {
  assert.equal(
    deriveAdName("I stopped snacking after 3pm", [], "Superfood Tabs"),
    "I stopped snacking after 3pm",
  );
});

test("a competitor brand token in the headline is stripped", () => {
  const cleaned = deriveAdName("Ryze mushroom coffee is fine", ["Ryze"], "Superfood Tabs");
  assert.equal(/ryze/i.test(cleaned), false);
  assert.equal(cleaned, "mushroom coffee is fine");
});

test("the literal source label 'competitor' is never present in the name", () => {
  const cleaned = deriveAdName("competitor swap: our real offer wins", [], "Superfood Tabs");
  assert.equal(/competitor/i.test(cleaned), false);
});

test("sanitized-to-empty headline falls back to the product title", () => {
  assert.equal(deriveAdName("weight loss", [], "Superfood Tabs"), "Superfood Tabs");
});

test("null / empty headline falls back to the product title", () => {
  assert.equal(deriveAdName("", [], "Superfood Tabs"), "Superfood Tabs");
});

test("empty headline + empty product title falls back to a safe non-empty default", () => {
  assert.equal(deriveAdName("", [], ""), "Dahlia ad");
});

test("multi-token advertiser (e.g. 'MUD WTR') strips every ≥3-char token", () => {
  const cleaned = deriveAdName("MUD WTR is bitter and ours is smooth", ["MUD", "WTR"], "Superfood Tabs");
  assert.equal(/mud|wtr/i.test(cleaned), false);
  assert.equal(cleaned, "is bitter and ours is smooth");
});

test("advertiser token with a slash ('MUD/WTR') still strips as a whole word", () => {
  const advertiser = "MUD/WTR";
  // The caller (insertReadyCreative) whitespace-splits the advertiser; a single token like
  // "MUD/WTR" arrives whole and is stripped via the manual word-boundary check.
  const cleaned = deriveAdName("MUD/WTR vs ours", [advertiser], "Superfood Tabs");
  assert.equal(/mud\/wtr/i.test(cleaned), false);
  assert.equal(cleaned, "vs ours");
});

test("stripping collapses runs of whitespace + trims orphan separators", () => {
  const cleaned = deriveAdName("— competitor · weight loss · winner —", [], "Superfood Tabs");
  assert.equal(cleaned, "winner");
});
