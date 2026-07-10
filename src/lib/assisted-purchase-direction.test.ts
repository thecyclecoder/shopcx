/**
 * Unit tests for the assisted-purchase Direction blueprint — Phase 3 of
 * docs/brain/specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol.md.
 *
 * The spec's Phase-3 verification bullets:
 *   1. Sol's Direction for a checkout-stuck ticket launches the ACTIVE
 *      `add-payment-method` journey (workspace-scoped, is_active=true) as the first
 *      step, then confirms which items, then asks one-time vs discounted Subscribe
 *      & Save, then hands to the right playbook.
 *   2. The reply NEVER claims the order is placed until the final placement step
 *      verifies (execute-then-confirm honor invariant — no false "it's placed").
 *
 * Pure — no DB, no network. Run:
 *   npx tsx --test src/lib/assisted-purchase-direction.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ASSISTED_PURCHASE_FINAL_STAGE,
  ASSISTED_PURCHASE_JOURNEY_SLUG,
  ASSISTED_PURCHASE_LEAD_IN,
  ASSISTED_PURCHASE_PLAYBOOK_SLUGS,
  ASSISTED_PURCHASE_STAGES,
  assertSolAssistedPurchaseReplyNeverClaimsPlaced,
  buildAssistedPurchaseFirstTurnDirection,
} from "./assisted-purchase-direction";

// ── Bullet 1: blueprint shape ──────────────────────────────────────────────

test("blueprint: 4-stage recipe is payment_journey → confirm_items → one_time_vs_ss → playbook_handoff", () => {
  assert.deepEqual(ASSISTED_PURCHASE_STAGES, [
    "payment_journey",
    "confirm_items",
    "one_time_vs_ss",
    "playbook_handoff",
  ]);
  assert.equal(ASSISTED_PURCHASE_FINAL_STAGE, "playbook_handoff");
});

test("blueprint: anchor slugs are add-payment-method + the two Phase-4 playbook slugs", () => {
  assert.equal(ASSISTED_PURCHASE_JOURNEY_SLUG, "add-payment-method");
  assert.equal(ASSISTED_PURCHASE_PLAYBOOK_SLUGS.oneTime, "assisted-order-purchase");
  assert.equal(ASSISTED_PURCHASE_PLAYBOOK_SLUGS.subscribeAndSave, "assisted-subscription-purchase");
});

test("blueprint: warm honest lead-in matches the spec phrasing verbatim", () => {
  assert.match(
    ASSISTED_PURCHASE_LEAD_IN,
    /I can just place this for you — no need to fight that screen/,
  );
});

test("buildAssistedPurchaseFirstTurnDirection: chosen_path='journey' + journey_slug='add-payment-method' + stages + handoff slugs", () => {
  const dir = buildAssistedPurchaseFirstTurnDirection();
  assert.equal(dir.chosen_path, "journey");
  assert.equal(dir.plan.journey_slug, "add-payment-method");
  // The 4-stage recipe is pinned on the Direction so downstream re-sessions can see
  // the whole intended flow, not just the current stage.
  assert.deepEqual(dir.plan.assisted_purchase_stages, [
    "payment_journey",
    "confirm_items",
    "one_time_vs_ss",
    "playbook_handoff",
  ]);
  // Phase-4 handoff slugs land on the Direction so a downstream re-session can't drift them.
  assert.equal(dir.plan.handoff_playbook_slugs.one_time, "assisted-order-purchase");
  assert.equal(dir.plan.handoff_playbook_slugs.subscribe_and_save, "assisted-subscription-purchase");
});

test("buildAssistedPurchaseFirstTurnDirection: guardrails encode the never-claim-placed honor invariant", () => {
  const dir = buildAssistedPurchaseFirstTurnDirection();
  assert.equal(dir.guardrails.never_promise_placed_until_verified, true);
  assert.ok(Array.isArray(dir.guardrails.escalate_if));
});

test("buildAssistedPurchaseFirstTurnDirection: first_reply defaults to the warm lead-in", () => {
  const dir = buildAssistedPurchaseFirstTurnDirection();
  assert.equal(dir.first_reply, ASSISTED_PURCHASE_LEAD_IN);
});

test("buildAssistedPurchaseFirstTurnDirection: caller can override intent + contextSummary + leadIn", () => {
  const dir = buildAssistedPurchaseFirstTurnDirection({
    intent: "Latrina couldn't finish checkout — Shop Pay OTP never arrived",
    contextSummary: "aa0b6697 — checkout-stuck via OTP not arriving; no active sub yet.",
    leadIn: "Custom lead-in for this ticket",
  });
  assert.equal(dir.intent, "Latrina couldn't finish checkout — Shop Pay OTP never arrived");
  assert.equal(dir.context_summary, "aa0b6697 — checkout-stuck via OTP not arriving; no active sub yet.");
  assert.equal(dir.first_reply, "Custom lead-in for this ticket");
  // The overrides do NOT touch the pinned chosen_path / plan / guardrails.
  assert.equal(dir.chosen_path, "journey");
  assert.equal(dir.plan.journey_slug, "add-payment-method");
});

// ── Bullet 2: never-claim-placed invariant ────────────────────────────────

// Positive detection cases — every claim-placed phrasing on an EARLIER stage blocks.

test("guard: 'I've placed your order' on payment_journey → BLOCK", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "payment_journey",
    firstReply: "Great — I've placed your order and you'll get an email confirmation shortly.",
  });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.kind, "claims_placed_before_final_stage");
    assert.equal(r.matched_phrase, "I've placed your order");
  }
});

test("guard: 'your order is placed' on confirm_items → BLOCK", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "confirm_items",
    firstReply: "Perfect — your order is placed. Which items did you want?",
  });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.kind, "claims_placed_before_final_stage");
  }
});

test("guard: 'your order is on its way' on one_time_vs_ss → BLOCK", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "one_time_vs_ss",
    firstReply: "Your order is on its way — would you prefer one-time or Subscribe & Save?",
  });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.kind, "claims_placed_before_final_stage");
  }
});

test("guard: 'we've charged your order' on payment_journey → BLOCK", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "payment_journey",
    firstReply: "We've charged your order — should be there in 3-5 days.",
  });
  assert.equal(r.ok, false);
});

test("guard: 'payment went through' on confirm_items → BLOCK", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "confirm_items",
    firstReply: "Payment went through — which items?",
  });
  assert.equal(r.ok, false);
});

// Final-stage semantics — placementVerified gates the allow.

test("guard: 'I've placed your order' on playbook_handoff WITH placementVerified=true → PASS", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "playbook_handoff",
    firstReply: "I've placed your order — you'll see a confirmation email shortly.",
    placementVerified: true,
  });
  assert.equal(r.ok, true, "final stage + verified placement is the only allowed claim-placed path");
});

test("guard: 'I've placed your order' on playbook_handoff WITHOUT placementVerified → BLOCK", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "playbook_handoff",
    firstReply: "I've placed your order.",
    placementVerified: false,
  });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.kind, "claims_placed_without_verification");
  }
});

test("guard: 'I've placed your order' on playbook_handoff with placementVerified=undefined → BLOCK", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "playbook_handoff",
    firstReply: "I've placed your order.",
  });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.kind, "claims_placed_without_verification");
  }
});

// Negative cases — the warm lead-in and future-tense promises PASS.

test("guard: the warm lead-in on payment_journey → PASS", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "payment_journey",
    firstReply: ASSISTED_PURCHASE_LEAD_IN,
  });
  assert.equal(r.ok, true, "the warm lead-in must not trip the guard");
});

test("guard: future-tense 'I'll place your order once you enter your card' on payment_journey → PASS", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "payment_journey",
    firstReply: "I'll place your order once you enter your card securely below.",
  });
  assert.equal(r.ok, true, "a future-tense promise is not a placement claim");
});

test("guard: 'which items would you like?' on confirm_items → PASS", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "confirm_items",
    firstReply: "Card is on file — which items would you like me to place?",
  });
  assert.equal(r.ok, true);
});

test("guard: 'one-time or Subscribe & Save?' on one_time_vs_ss → PASS", () => {
  const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({
    stage: "one_time_vs_ss",
    firstReply: "Would you like a one-time order (higher price) or Subscribe & Save (discounted)?",
  });
  assert.equal(r.ok, true);
});

test("guard: an empty reply on any stage → PASS (nothing to block)", () => {
  for (const stage of ASSISTED_PURCHASE_STAGES) {
    const r = assertSolAssistedPurchaseReplyNeverClaimsPlaced({ stage, firstReply: "" });
    assert.equal(r.ok, true, `empty reply must not trip the guard on stage='${stage}'`);
  }
});
