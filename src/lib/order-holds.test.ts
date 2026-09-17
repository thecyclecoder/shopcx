/**
 * order-holds — pure-predicate tests for `isAllergyEscalation`, the detector that
 * decides whether `escalateTicket` fans out to `attemptAllergenHold`.
 *
 * Same node:test convention as orders-classification.test.ts. Run:
 *   npx tsx --test src/lib/order-holds.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isAllergyEscalation } from "./order-holds";

test("matches the policy's canonical reason", () => {
  assert.equal(
    isAllergyEscalation("allergy/safety report — needs immediate review"),
    true,
  );
});

test("matches a bare allergy mention", () => {
  assert.equal(isAllergyEscalation("customer reports allergy to hazelnuts"), true);
  assert.equal(isAllergyEscalation("allergen exposure claimed"), true);
});

test("matches anaphylaxis / anaphylactic wording", () => {
  assert.equal(isAllergyEscalation("possible anaphylactic reaction reported"), true);
  assert.equal(isAllergyEscalation("anaphylaxis after opening the coffee bag"), true);
});

test("matches 'safety review' variants (case-insensitive, hyphen/underscore-tolerant)", () => {
  assert.equal(isAllergyEscalation("Safety Report — please review"), true);
  assert.equal(isAllergyEscalation("safety_review triggered"), true);
  assert.equal(isAllergyEscalation("SAFETY-REPORT"), true);
});

test("does NOT match unrelated escalation reasons", () => {
  assert.equal(isAllergyEscalation("assisted_purchase_orchestrator_missing_intent:assisted-order-purchase"), false);
  assert.equal(isAllergyEscalation("blocked_unbacked_claim:cta_tail"), false);
  assert.equal(isAllergyEscalation("ai_holding_promise"), false);
  assert.equal(isAllergyEscalation("Refund exceeds authorised amount"), false);
});

test("null / empty / non-string is not a match", () => {
  assert.equal(isAllergyEscalation(null), false);
  assert.equal(isAllergyEscalation(undefined), false);
  assert.equal(isAllergyEscalation(""), false);
});
