/**
 * order-holds — pure-predicate tests for `isAllergyEscalation`, the detector that
 * decides whether `escalateTicket` fans out to `attemptAllergenHold`.
 *
 * Same node:test convention as orders-classification.test.ts. Run:
 *   npx tsx --test src/lib/order-holds.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isAllergyEscalation, renderOrderHoldForContext } from "./order-holds";

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

// ── renderOrderHoldForContext — Phase 2: three distinguishable ticket-surface states ────

test("renderOrderHoldForContext: PLACED renders as a hold-placed line naming the order + reason", () => {
  const line = renderOrderHoldForContext(
    {
      status: "placed",
      kind: "allergen",
      reason: "customer reports hazelnut allergy",
      ticketId: "t-1",
      placedAt: "2026-09-13T02:33:00Z",
      refusedReason: null,
    },
    "SC138523",
    true,
  );
  assert.ok(line, "PLACED must render a line");
  assert.match(line!, /PLACED/);
  assert.match(line!, /SC138523/);
  assert.match(line!, /allergen/);
  assert.match(line!, /must not ship/);
});

test("renderOrderHoldForContext: REFUSED renders as an alert with the refused reason", () => {
  const line = renderOrderHoldForContext(
    {
      status: "refused",
      kind: "allergen",
      reason: "customer reports hazelnut allergy",
      ticketId: "t-1",
      placedAt: "2026-09-15T00:52:00Z",
      refusedReason: "already_shipped",
    },
    "SC138523",
    true,
  );
  assert.ok(line, "REFUSED must render a line");
  assert.match(line!, /REFUSED/);
  assert.match(line!, /already_shipped/);
  assert.match(line!, /collapsed to a refund/);
});

test("renderOrderHoldForContext: null on a live allergy ticket renders as a 'NEVER attempted' alert", () => {
  const line = renderOrderHoldForContext(null, "SC138523", true);
  assert.ok(line, "null hold on a live allergy ticket must render an alert");
  assert.match(line!, /NO allergen hold/);
  assert.match(line!, /Do NOT promise a stop/);
});

test("renderOrderHoldForContext: null on a non-allergy ticket renders NOTHING (quiet)", () => {
  const line = renderOrderHoldForContext(null, "SC138523", false);
  assert.equal(line, null);
});

test("renderOrderHoldForContext: three PLACED / REFUSED / null states are distinguishable strings", () => {
  const placed = renderOrderHoldForContext(
    { status: "placed", kind: "allergen", reason: "r", ticketId: null, placedAt: null, refusedReason: null },
    "SC1",
    true,
  );
  const refused = renderOrderHoldForContext(
    { status: "refused", kind: "allergen", reason: "r", ticketId: null, placedAt: null, refusedReason: "already_shipped" },
    "SC1",
    true,
  );
  const absent = renderOrderHoldForContext(null, "SC1", true);
  assert.ok(placed && refused && absent);
  assert.notEqual(placed, refused);
  assert.notEqual(placed, absent);
  assert.notEqual(refused, absent);
});
