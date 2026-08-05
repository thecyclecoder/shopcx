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

test("message_only closes + de-escalates + unassigns — resolves rather than parks so the ticket cannot feed the loop Phase 1 caps", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "message_only",
    reasoning: "Money already unwound; the residue was that the customer was never told. One message + close.",
    remedy: { customer_message: "You were charged $182.95 for SC135494; $15 was refunded and a prepaid label is on the way." },
    now: NOW,
  });
  assert.equal(
    t.action_key,
    "close_and_deescalate",
    "message_only IS a resolution — it must close, not linger; a lingering message_only ticket would re-enter the CS auto-router and re-hit the loop-guard cap",
  );
  assert.equal(t.patch.status, "closed");
  assert.equal(t.patch.closed_at, NOW);
  assert.equal(t.patch.escalated_at, null);
  assert.equal(t.patch.escalated_to, null);
  assert.equal(t.patch.escalation_reason, null);
  assert.equal(t.patch.assigned_to, null);
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

test("approve_remedy that the mutator RESOLVED (fired + reply delivered) closes the ticket", () => {
  // The Melissa/eca3f43b fix: June's remedy carried a customer_reply (no explicit
  // close signal), but the mutator executed cleanly and delivered it — so the
  // ticket is resolved and must close, not linger open.
  const t = decideCsDirectorTicketTransition({
    decision: "approve_remedy",
    reasoning: "Return for full refund + reply.",
    remedy: { kind: "refund_return", customer_message: "Send the tabs back with the label…" },
    remedyResolved: true,
    now: NOW,
  });
  assert.equal(t.action_key, "close_and_deescalate");
  assert.equal(t.patch.status, "closed");
  assert.equal(t.patch.resolved_at, NOW);
  assert.equal(t.patch.closed_at, NOW);
  assert.equal(t.patch.escalated_at, null);
});

test("approve_remedy NOT resolved (parked/failed) still only de-escalates — never auto-closes", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "approve_remedy",
    reasoning: "Refund over threshold — parked for founder approval.",
    remedy: { kind: "refund_order", customer_message: "…" },
    remedyResolved: false,
    now: NOW,
  });
  assert.equal(t.action_key, "deescalate_only");
  assert.equal(t.patch.status, undefined);
  assert.equal(t.patch.closed_at, undefined);
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

// docs/brain/specs/post-resolution-inbound-reroute-and-silent-turn-guard.md § Phase 1
// (derived-from Melissa/eca3f43b): a June-resolved ticket must not resume a stale pre-
// escalation playbook on a later customer follow-up. Both resolution-side patches must
// nullify the three playbook fields idempotently; `escalate_founder` leaves them alone
// because the founder ruling may still fold back into the pre-escalation lane.
test("close_and_deescalate patches clear the active playbook (author_spec + close_no_action + resolved-remedy)", () => {
  for (const decision of ["author_spec", "close_no_action"] as const) {
    const t = decideCsDirectorTicketTransition({ decision, reasoning: "x", now: NOW });
    assert.equal(t.action_key, "close_and_deescalate");
    assert.equal(t.patch.active_playbook_id, null, `${decision} clears active_playbook_id`);
    assert.equal(t.patch.playbook_step, 0, `${decision} resets playbook_step`);
    assert.equal(t.patch.playbook_exceptions_used, 0, `${decision} resets playbook_exceptions_used`);
  }
  const resolvedRemedy = decideCsDirectorTicketTransition({
    decision: "approve_remedy",
    reasoning: "resolved.",
    remedy: { kind: "refund_return", customer_message: "…" },
    remedyResolved: true,
    now: NOW,
  });
  assert.equal(resolvedRemedy.action_key, "close_and_deescalate");
  assert.equal(resolvedRemedy.patch.active_playbook_id, null);
  assert.equal(resolvedRemedy.patch.playbook_step, 0);
  assert.equal(resolvedRemedy.patch.playbook_exceptions_used, 0);
});

test("deescalate_only patches also clear the active playbook (customer-reply-pending remedy)", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "approve_remedy",
    reasoning: "refund + reply.",
    remedy: { kind: "refund_order", customer_reply: "…" },
    now: NOW,
  });
  assert.equal(t.action_key, "deescalate_only");
  assert.equal(t.patch.active_playbook_id, null);
  assert.equal(t.patch.playbook_step, 0);
  assert.equal(t.patch.playbook_exceptions_used, 0);
});

test("escalate_founder does NOT touch the active playbook (defer, not resolve)", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "escalate_founder",
    reasoning: "Founder call.",
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_ceo_owned");
  assert.equal(t.patch.active_playbook_id, undefined);
  assert.equal(t.patch.playbook_step, undefined);
  assert.equal(t.patch.playbook_exceptions_used, undefined);
});

// ── Phase 2 of cs-director-spec-claim-must-match-the-actual-write ──
// The irreversible half of ticket 2b7ea029: the ticket was CLOSED + DE-ESCALATED on a phantom
// `author_spec` verdict, and nobody revisits a closed ticket — so the missing spec was invisible
// for a day. The transition must close ONLY on a CONFIRMED write. A failed write leaves the
// ticket OPEN + ESCALATED + escalation_reason stamped with the failure reason so it lands back
// in the queue for a human, not on the "resolved" pile.

test("Phase 2 — author_spec with a CONFIRMED write (outcome specWritten:true) still closes + de-escalates + clears the playbook", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "Analyzer gap.",
    authorSpecOutcome: { specWritten: true },
    now: NOW,
  });
  assert.equal(t.action_key, "close_and_deescalate");
  assert.equal(t.patch.status, "closed");
  assert.equal(t.patch.escalated_at, null);
  assert.equal(t.patch.active_playbook_id, null);
});

test("Phase 2 — author_spec with a FAILED write (outcome specWritten:false) leaves the ticket OPEN + ESCALATED + needs_attention", () => {
  // The exact regression class from ticket 2b7ea029 — the SDK's chokepoint guard rejected the
  // write. The transition MUST NOT close: the ticket stays open, escalation is not cleared, and
  // escalation_reason names the failure so a CS agent scanning the queue immediately sees WHY
  // the ticket is back in-queue instead of resolved.
  const t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "Bug identified, structural fix needed.",
    authorSpecOutcome: { specWritten: false, reason: "author_spec_write_returned_false" },
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_needs_attention");
  // MUST NOT close — the phantom-close was the irreversible half of the miss.
  assert.equal(t.patch.status, undefined);
  assert.equal(t.patch.closed_at, undefined);
  assert.equal(t.patch.resolved_at, undefined);
  // MUST NOT clear the escalation — the ticket lands back in-queue.
  assert.equal(t.patch.escalated_at, undefined);
  assert.equal(t.patch.escalated_to, undefined);
  // MUST stamp the escalation_reason with the failure so the queue reader sees WHY.
  assert.match(String(t.patch.escalation_reason), /author_spec FAILED \(author_spec_write_returned_false\)/);
  assert.match(String(t.patch.escalation_reason), /no spec was written/);
  assert.match(String(t.patch.escalation_reason), /needs human review/);
  assert.equal(t.patch.updated_at, NOW);
  // MUST NOT clear the pre-escalation playbook — the structural fix never landed; a customer
  // follow-up may still legitimately resume the pre-escalation lane after a human resolves this.
  assert.equal(t.patch.active_playbook_id, undefined);
  assert.equal(t.patch.playbook_step, undefined);
  assert.equal(t.patch.playbook_exceptions_used, undefined);
});

test("Phase 2 — author_spec failed write with ticket_id_unresolved reason renders the same needs-attention shape", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "Analyzer gap identified.",
    authorSpecOutcome: { specWritten: false, reason: "ticket_id_unresolved" },
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_needs_attention");
  assert.equal(t.patch.status, undefined);
  assert.match(String(t.patch.escalation_reason), /author_spec FAILED \(ticket_id_unresolved\)/);
});

test("Phase 2 — author_spec failed write with an empty reason still stamps a needs-attention reason (unknown_reason fallback)", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "x",
    authorSpecOutcome: { specWritten: false },
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_needs_attention");
  assert.match(String(t.patch.escalation_reason), /author_spec FAILED \(unknown_reason\)/);
});

test("Phase 2 — author_spec without an outcome (legacy back-compat) still closes + de-escalates (unchanged shipped behavior)", () => {
  // A stale caller that predates Phase 2 (or a unit test above that doesn't thread the outcome)
  // gets the original close_and_deescalate shape so nothing regresses. The shipped
  // runCsDirectorCallJob call site ALWAYS threads the outcome; this path exists only for back-compat.
  const t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "x",
    now: NOW,
  });
  assert.equal(t.action_key, "close_and_deescalate");
  assert.equal(t.patch.status, "closed");
});
