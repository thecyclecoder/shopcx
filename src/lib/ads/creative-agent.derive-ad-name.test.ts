/**
 * deriveAdName tests — pin the Phase 1 rules of
 * [[../../../docs/brain/specs/dahlia-names-each-ad-from-its-headline-minus-weight-loss-not-a-generic-template.md]]:
 *   npx tsx --test src/lib/ads/creative-agent.derive-ad-name.test.ts
 *
 * The composite name at the insertReadyCreative call site is
 *   `Dahlia - ${productTitle} - ${deriveAdName(headline, competitorTokens, conceptTag)}`.
 * These tests exercise deriveAdName in isolation (returning JUST the sanitized trailing slot)
 * plus a small handful of compose-and-assert cases so the final string shape is pinned end-to-end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveAdName } from "./creative-agent";

/** Mirror of the composition the insertReadyCreative call site does — keeps the pinned
 *  composite shape here so a caller-side drift shows up in this test file too. */
const compose = (productTitle: string, headline: string, tokens: string[], fallback = "ad") =>
  `Dahlia - ${productTitle} - ${deriveAdName(headline, tokens, fallback)}`;

test("weight-loss phrase is stripped from the derived headline slot (case-insensitive)", () => {
  assert.equal(deriveAdName("Lose Weight Loss Fast", [], "ad"), "Lose Fast");
});

test("composite name 'Lose Weight Loss Fast' → 'Dahlia - Superfood Tabs - Lose Fast'", () => {
  assert.equal(
    compose("Superfood Tabs", "Lose Weight Loss Fast", []),
    "Dahlia - Superfood Tabs - Lose Fast",
  );
});

test("'weightloss' (no space) is stripped too", () => {
  assert.equal(deriveAdName("Weightloss made easy", [], "ad"), "made easy");
});

test("a clean headline passes through unchanged", () => {
  assert.equal(
    deriveAdName("I stopped snacking after 3pm", [], "ad"),
    "I stopped snacking after 3pm",
  );
});

test("composite: clean headline composes cleanly under the 'Dahlia - {product} -' prefix", () => {
  assert.equal(
    compose("Superfood Tabs", "I stopped snacking after 3pm", []),
    "Dahlia - Superfood Tabs - I stopped snacking after 3pm",
  );
});

test("a competitor brand token in the headline is stripped from the trailing slot", () => {
  const cleaned = deriveAdName("Ryze mushroom coffee is fine", ["Ryze"], "ad");
  assert.equal(/ryze/i.test(cleaned), false);
  assert.equal(cleaned, "mushroom coffee is fine");
});

test("composite: competitor brand never appears in the final composite name", () => {
  const name = compose("Superfood Tabs", "Ryze mushroom coffee is fine", ["Ryze"]);
  assert.equal(/ryze/i.test(name), false);
  assert.equal(name, "Dahlia - Superfood Tabs - mushroom coffee is fine");
});

test("the literal source label 'competitor' is never present in the derived slot", () => {
  const cleaned = deriveAdName("competitor swap: our real offer wins", [], "ad");
  assert.equal(/competitor/i.test(cleaned), false);
});

test("sanitized-to-empty headline falls back to the concept-tag label ('transformation')", () => {
  // Author-mode call site passes `authorModeCopy?.concept_tag` as the fallback so the composite
  // never has an empty trailing slot — a short descriptive stand-in.
  assert.equal(deriveAdName("weight loss", [], "transformation"), "transformation");
});

test("composite: 'weight loss'-only headline + author-mode concept tag → 'Dahlia - {product} - transformation'", () => {
  assert.equal(
    compose("Superfood Tabs", "weight loss", [], "transformation"),
    "Dahlia - Superfood Tabs - transformation",
  );
});

test("deterministic-mode empty fallback is the safe default 'ad'", () => {
  assert.equal(deriveAdName("weight loss", [], "ad"), "ad");
  assert.equal(deriveAdName("", [], "ad"), "ad");
});

test("multi-token advertiser (e.g. 'MUD WTR') strips every ≥3-char token", () => {
  const cleaned = deriveAdName("MUD WTR is bitter and ours is smooth", ["MUD", "WTR"], "ad");
  assert.equal(/mud|wtr/i.test(cleaned), false);
  assert.equal(cleaned, "is bitter and ours is smooth");
});

test("advertiser token with a slash ('MUD/WTR') still strips as a whole word", () => {
  // The caller (insertReadyCreative) whitespace-splits the advertiser; a single token like
  // "MUD/WTR" arrives whole and is stripped via the manual word-boundary check.
  const cleaned = deriveAdName("MUD/WTR vs ours", ["MUD/WTR"], "ad");
  assert.equal(/mud\/wtr/i.test(cleaned), false);
  assert.equal(cleaned, "vs ours");
});

test("stripping collapses runs of whitespace + trims orphan separators", () => {
  const cleaned = deriveAdName("— competitor · weight loss · winner —", [], "ad");
  assert.equal(cleaned, "winner");
});

test("composite pin: the final name shape is always 'Dahlia - {product} - {slot}' (never a middot template)", () => {
  const name = compose("Superfood Tabs", "She quit snacking after 3pm", []);
  assert.equal(name.startsWith("Dahlia - Superfood Tabs - "), true);
  assert.equal(name.includes(" · "), false);
});
