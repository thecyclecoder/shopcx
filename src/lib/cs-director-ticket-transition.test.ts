/**
 * Unit tests for `decideCsDirectorTicketTransition` — the pure per-verdict `tickets` patch
 * builder used by `runCsDirectorCallJob` to close Phase 2 of the loop-closure spec
 * (cs-director-call-closes-the-ticket-loop-note-and-resolution-per-verdict).
 *
 * Verification (each bullet mirrors the spec's Phase-2 Verification block):
 *   - author_spec  → ticket is no longer open+escalated: patch closes it + clears escalation +
 *                    unassigns.
 *   - approve_remedy WITH no-customer-reply signal → same as author_spec (closed + cleared).
 *   - approve_remedy default (customer reply pending) → escalation is cleared so the ticket is
 *                    not stranded, but status is NOT flipped (the executor's next turn will).
 *   - escalate_founder → escalation stays set, escalation_reason marks CEO ownership, and
 *                    escalated_to is stamped when the caller resolved the workspace-owner id.
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/cs-director-ticket-transition.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideCsDirectorTicketTransition } from "./cs-director-ticket-transition";

const NOW = "2026-07-08T12:00:00.000Z";

test("author_spec closes the ticket, clears the escalation, and unassigns", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "Analyzer gap — repeat coupon routing.",
    now: NOW,
  });
  assert.equal(t.action_key, "close_and_deescalate");
  assert.equal(t.patch.status, "closed");
  assert.equal(t.patch.resolved_at, NOW);
  assert.equal(t.patch.closed_at, NOW);
  assert.equal(t.patch.escalated_at, null);
  assert.equal(t.patch.escalated_to, null);
  assert.equal(t.patch.escalation_reason, null);
  assert.equal(t.patch.assigned_to, null);
  assert.equal(t.patch.updated_at, NOW);
});

test("close_no_action closes + de-escalates + unassigns (a correctly-handled no-op, not a founder page)", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "close_no_action",
    reasoning: "Phantom $236.50 charge — no such order on this customer or any linked identity; AI already asked for the order number. No remedy, no founder call.",
    now: NOW,
  });
  assert.equal(t.action_key, "close_and_deescalate");
  assert.equal(t.patch.status, "closed");
  assert.equal(t.patch.closed_at, NOW);
  assert.equal(t.patch.escalated_at, null);
  assert.equal(t.patch.escalated_to, null);
  assert.equal(t.patch.escalation_reason, null);
  assert.equal(t.patch.assigned_to, null);
});

test("approve_remedy WITH close signal closes + de-escalates the ticket", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "approve_remedy",
    reasoning: "Approved.",
    remedy: { kind: "refund_order", needs_customer_reply: false },
    now: NOW,
  });
  assert.equal(t.action_key, "close_and_deescalate");
  assert.equal(t.patch.status, "closed");
  assert.equal(t.patch.escalated_at, null);
});

test("approve_remedy WITH resolves_ticket:true also closes + de-escalates", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "approve_remedy",
    reasoning: "Approved.",
    remedy: { kind: "refund_order", resolves_ticket: true },
    now: NOW,
  });
  assert.equal(t.action_key, "close_and_deescalate");
  assert.equal(t.patch.status, "closed");
});

test("approve_remedy default (customer reply pending) de-escalates but does NOT flip status", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "approve_remedy",
    reasoning: "Refund + reply.",
    remedy: { kind: "refund_order", customer_reply: "We caught the pricing error…" },
    now: NOW,
  });
  assert.equal(t.action_key, "deescalate_only");
  assert.equal(t.patch.status, undefined);
  assert.equal(t.patch.closed_at, undefined);
  assert.equal(t.patch.escalated_at, null);
  assert.equal(t.patch.escalated_to, null);
  assert.equal(t.patch.escalation_reason, null);
  assert.equal(t.patch.updated_at, NOW);
});

test("approve_remedy with no remedy object at all is treated as customer-reply-pending", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "approve_remedy",
    reasoning: "Approved.",
    now: NOW,
  });
  assert.equal(t.action_key, "deescalate_only");
});

test("escalate_founder keeps the escalation but marks CEO ownership on the reason line", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "escalate_founder",
    reasoning: "Chargeback storm — needs a CEO ruling.",
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_ceo_owned");
  // Escalation is NOT cleared — the ticket stays escalated but is now owned.
  assert.equal(t.patch.escalated_at, undefined);
  assert.equal(t.patch.status, undefined);
  assert.match(String(t.patch.escalation_reason), /CEO — awaits founder ruling/);
  assert.match(String(t.patch.escalation_reason), /Chargeback storm/);
  assert.equal(t.patch.updated_at, NOW);
  // No ceoUserId → escalated_to is not stamped (routine's default lane is not stepped on).
  assert.equal(t.patch.escalated_to, undefined);
});

test("escalate_founder stamps escalated_to when the workspace-owner user_id is known", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "escalate_founder",
    reasoning: "Founder call needed.",
    ceoUserId: "00000000-0000-0000-0000-0000000000ce",
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_ceo_owned");
  assert.equal(t.patch.escalated_to, "00000000-0000-0000-0000-0000000000ce");
  assert.match(String(t.patch.escalation_reason), /CEO — awaits founder ruling/);
});

test("escalate_founder falls back gracefully on an empty reasoning string", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "escalate_founder",
    reasoning: "",
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_ceo_owned");
  assert.match(String(t.patch.escalation_reason), /CEO — awaits founder ruling: see cs-director verdict/);
});
