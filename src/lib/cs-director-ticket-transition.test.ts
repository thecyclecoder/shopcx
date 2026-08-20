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
import {
  FOUNDER_RULING_PREFIX,
  decideCsDirectorTicketTransition,
  isAwaitingFounderRuling,
} from "./cs-director-ticket-transition";

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

test("june-authored-specs-carry-machine-runnable-checks Phase 2 — a failed author_spec stamps escalated_to = ceoUserId when the caller can resolve the workspace owner", () => {
  // Before this shipped, a failed author_spec kept the ticket escalated but left escalated_to
  // untouched — the ticket sat open with NO OWNER on the escalated view (Yvonne Carreon: 2.6 days
  // sitting in that limbo). Phase 2 stamps the founder so the ticket lands in the founder-escalated
  // view alongside every other escalate_founder verdict, and the CEO card the runner mints for
  // this branch pairs with this ownership stamp.
  const t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "Analyzer gap — the spec write threw and no fix landed.",
    authorSpecOutcome: { specWritten: false, reason: "author_spec_threw" },
    ceoUserId: "founder-user-123",
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_needs_attention");
  assert.equal(t.patch.escalated_to, "founder-user-123");
  // Still MUST NOT close — the phantom-close was the irreversible half of the pre-Phase-2 miss.
  assert.equal(t.patch.status, undefined);
  assert.equal(t.patch.closed_at, undefined);
  assert.equal(t.patch.resolved_at, undefined);
  // Escalation not cleared (escalated_at stays), reason stamped.
  assert.equal(t.patch.escalated_at, undefined);
  assert.match(String(t.patch.escalation_reason), /author_spec FAILED \(author_spec_threw\)/);
});

// ── Phase 1 of a-cs-director-verdict-cannot-clear-an-unruled-founder-escalation ──
// Motivating case: ticket c969f235 (G esposito, 2026-08-18). June ruled `escalate_founder` at
// 15:53 (escalation_reason='CEO — awaits founder ruling: …'), a second June session ruled
// `author_spec` at 16:36, and the pre-change transition unconditionally closed + cleared the
// founder escalation with no card + no note. The customer's 16:53 reply reopened the ticket
// UNESCALATED, so it read as a dropped hand-off and sat invisible to the founder for 19h on a
// $1,628-LTV customer. The invariant these tests pin: while `escalation_reason` still carries
// the `CEO — awaits founder ruling:` prefix (an earlier `escalate_founder` verdict stamped it),
// a later verdict that would clear the escalation is DOWNGRADED to
// `keep_escalated_founder_ruling_pending` — the ticket stays open + escalated. The single
// exception is an `approve_remedy` that RESOLVED the customer's issue (remedyResolved===true).

const FOUNDER_PRIOR = {
  escalated_to: "founder-user-123",
  escalation_reason: `${FOUNDER_RULING_PREFIX} Chargeback storm — needs a CEO ruling.`,
};
const NON_FOUNDER_PRIOR = {
  escalated_to: "someone-else-id",
  escalation_reason: "approval_pending: refund > threshold",
};

test("Phase 1 — isAwaitingFounderRuling predicate returns true only for the prefix the writer stamps", () => {
  assert.equal(isAwaitingFounderRuling(FOUNDER_PRIOR), true);
  assert.equal(isAwaitingFounderRuling(NON_FOUNDER_PRIOR), false);
  assert.equal(isAwaitingFounderRuling(null), false);
  assert.equal(isAwaitingFounderRuling(undefined), false);
  assert.equal(isAwaitingFounderRuling({ escalation_reason: null } as { escalation_reason: string | null }), false);
  assert.equal(isAwaitingFounderRuling({ escalation_reason: "" }), false);
  // Keyed on the prefix, not on `escalated_to` (raiseJuneRemedyApproval also stamps that column).
  assert.equal(
    isAwaitingFounderRuling({ escalation_reason: `${FOUNDER_RULING_PREFIX} …` }),
    true,
  );
});

test("Phase 1 — author_spec on a founder-escalated ticket is DOWNGRADED to keep_escalated_founder_ruling_pending (ticket c969f235 — the 16:36 second-session verdict must not clear the 15:53 founder page)", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "Analyzer gap — repeat coupon routing.",
    authorSpecOutcome: { specWritten: true },
    priorEscalation: FOUNDER_PRIOR,
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_founder_ruling_pending");
  // The ticket must stay OPEN — the phantom close was half the c969f235 miss.
  assert.equal(t.patch.status, undefined);
  assert.equal(t.patch.closed_at, undefined);
  assert.equal(t.patch.resolved_at, undefined);
  assert.equal(t.patch.assigned_to, undefined);
  // The founder escalation must be PRESERVED — no null-outs.
  assert.equal(t.patch.escalated_at, undefined);
  assert.equal(t.patch.escalated_to, undefined);
  assert.equal(t.patch.escalation_reason, undefined);
  // The pre-escalation playbook IS cleared (the founder-owned escalation supersedes it) and
  // updated_at is stamped so the change is visible to reader tools.
  assert.equal(t.patch.active_playbook_id, null);
  assert.equal(t.patch.playbook_step, 0);
  assert.equal(t.patch.playbook_exceptions_used, 0);
  assert.equal(t.patch.updated_at, NOW);
});

test("Phase 1 — close_no_action on a founder-escalated ticket is DOWNGRADED (a 'nothing to do' verdict must not silently retire the founder page)", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "close_no_action",
    reasoning: "Phantom charge — nothing to do here.",
    priorEscalation: FOUNDER_PRIOR,
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_founder_ruling_pending");
  assert.equal(t.patch.status, undefined);
  assert.equal(t.patch.escalated_at, undefined);
  assert.equal(t.patch.escalation_reason, undefined);
});

test("Phase 1 — message_only on a founder-escalated ticket is DOWNGRADED (a customer message alone cannot retire an unruled founder page)", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "message_only",
    reasoning: "Customer explanation — no money mutation.",
    remedy: { customer_message: "Here's what happened…" },
    priorEscalation: FOUNDER_PRIOR,
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_founder_ruling_pending");
  assert.equal(t.patch.status, undefined);
  assert.equal(t.patch.escalated_at, undefined);
});

test("Phase 1 — approve_remedy UNRESOLVED on a founder-escalated ticket is DOWNGRADED (deescalate_only would have cleared the founder page)", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "approve_remedy",
    reasoning: "Refund + reply.",
    remedy: { kind: "refund_order", customer_reply: "We caught the pricing error…" },
    remedyResolved: false,
    priorEscalation: FOUNDER_PRIOR,
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_founder_ruling_pending");
  assert.equal(t.patch.status, undefined);
  assert.equal(t.patch.escalated_at, undefined);
  assert.equal(t.patch.escalation_reason, undefined);
});

test("Phase 1 — approve_remedy RESOLVED on a founder-escalated ticket STILL closes + clears (a resolved issue retires its own escalation)", () => {
  // The single exception to the sticky invariant — same principle as the shipped
  // an-escalation-retires-itself-when-the-condition-it-reported-self-heals spec: if the mutator
  // actually fired the actions + delivered the reply, the customer's issue is resolved and the
  // founder page it caused is no longer needed. Close + clear.
  const t = decideCsDirectorTicketTransition({
    decision: "approve_remedy",
    reasoning: "Return for full refund + reply — executed cleanly.",
    remedy: { kind: "refund_return", customer_message: "Send the tabs back with the label…" },
    remedyResolved: true,
    priorEscalation: FOUNDER_PRIOR,
    now: NOW,
  });
  assert.equal(t.action_key, "close_and_deescalate");
  assert.equal(t.patch.status, "closed");
  assert.equal(t.patch.escalated_at, null);
  assert.equal(t.patch.escalated_to, null);
  assert.equal(t.patch.escalation_reason, null);
});

test("Phase 1 — absent priorEscalation reproduces today's behavior for every verdict (a read failure must NEVER strand a ticket escalated forever)", () => {
  // author_spec confirmed write — still close+clear
  let t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "x",
    authorSpecOutcome: { specWritten: true },
    now: NOW,
  });
  assert.equal(t.action_key, "close_and_deescalate");
  // close_no_action — still close+clear
  t = decideCsDirectorTicketTransition({ decision: "close_no_action", reasoning: "x", now: NOW });
  assert.equal(t.action_key, "close_and_deescalate");
  // approve_remedy unresolved — still deescalate_only
  t = decideCsDirectorTicketTransition({
    decision: "approve_remedy",
    reasoning: "x",
    remedy: { kind: "refund_order", customer_reply: "…" },
    now: NOW,
  });
  assert.equal(t.action_key, "deescalate_only");
  // explicit null — same as absent
  t = decideCsDirectorTicketTransition({
    decision: "close_no_action",
    reasoning: "x",
    priorEscalation: null,
    now: NOW,
  });
  assert.equal(t.action_key, "close_and_deescalate");
});

test("Phase 1 — a ticket escalated with a NON-founder reason still closes + clears (the invariant is scoped to the founder-ruling prefix, not to any escalation)", () => {
  const t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "Analyzer gap.",
    authorSpecOutcome: { specWritten: true },
    priorEscalation: NON_FOUNDER_PRIOR,
    now: NOW,
  });
  assert.equal(t.action_key, "close_and_deescalate");
  assert.equal(t.patch.status, "closed");
  assert.equal(t.patch.escalation_reason, null);
});

test("Phase 1 — the downgrade does NOT touch keep_escalated_ceo_owned (a fresh escalate_founder verdict re-stamps the reason and passes through)", () => {
  // A second June session re-escalating the same ticket must still stamp the fresh reason line
  // (with the current session's reasoning) — the downgrade only fires on the two clearing keys.
  const t = decideCsDirectorTicketTransition({
    decision: "escalate_founder",
    reasoning: "Additional context — still needs CEO.",
    priorEscalation: FOUNDER_PRIOR,
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_ceo_owned");
  assert.match(String(t.patch.escalation_reason), /Additional context/);
});

test("Phase 1 — the downgrade does NOT touch keep_escalated_needs_attention (a failed author_spec on a founder-escalated ticket still stamps the failure reason)", () => {
  // If the second-session verdict was `author_spec` that FAILED to write, keep_escalated_needs_
  // attention is already a preserving transition — do NOT downgrade it (the failure-reason stamp
  // is more informative than the founder-ruling-pending stamp already on the row).
  const t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "Bug identified.",
    authorSpecOutcome: { specWritten: false, reason: "author_spec_write_returned_false" },
    priorEscalation: FOUNDER_PRIOR,
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_needs_attention");
  assert.match(String(t.patch.escalation_reason), /author_spec FAILED/);
});

test("june-authored-specs-carry-machine-runnable-checks Phase 2 — a failed author_spec WITHOUT a resolvable ceoUserId still keeps-escalated (escalated_to left untouched — the CEO card is the surface)", () => {
  // The CEO card the runner mints is the primary human-visible surface for this branch. When the
  // owner lookup fails (a race, RLS drop, workspace with no owner), we still want the ticket to
  // stay escalated + reason-stamped so the card matches a queue entry — but we MUST NOT invent
  // an escalated_to. Leaving it undefined preserves whatever was there before June's review.
  const t = decideCsDirectorTicketTransition({
    decision: "author_spec",
    reasoning: "SDK threw, no spec landed.",
    authorSpecOutcome: { specWritten: false, reason: "author_spec_threw" },
    ceoUserId: null,
    now: NOW,
  });
  assert.equal(t.action_key, "keep_escalated_needs_attention");
  assert.equal(t.patch.escalated_to, undefined);
  assert.match(String(t.patch.escalation_reason), /author_spec FAILED \(author_spec_threw\)/);
});
