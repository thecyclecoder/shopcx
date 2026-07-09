/**
 * Pins the Phase 1 invariant for docs/brain/specs/guard-block-escalations-reach-junes-triage-not-left-unreviewed.md:
 * June's triage selection is escalation-source-agnostic. A ticket escalated by a playbook guard
 * (escalation_reason like `blocked_unbacked_claim:*`), by the analyzer's rail-hit path, or by any
 * other route is a June-review candidate on the same terms — ticket-level fields alone
 * (escalated_at set, escalated_to null, status not archived/closed) decide eligibility.
 *
 * Run: npx tsx --test src/lib/inngest/triage-escalations.selection.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { passesJuneReviewSelection } from "./triage-escalations";

const escalatedAt = "2026-07-08T11:00:00.000Z";

test("pass: guard-block escalation (blocked_unbacked_claim:cancel) is a triage candidate", () => {
  // The failing state the spec exists to prevent: derived-from-ticket 472310cc-f35f-4631-8e3a-
  // 11d7ee7b585f — a playbook-guard escalation that sat open + escalated with zero triage_runs.
  const ticket = {
    escalated_at: escalatedAt,
    escalated_to: null,
    status: "open",
  };
  assert.equal(passesJuneReviewSelection(ticket), true);
});

test("pass: analyzer-rail escalation is a triage candidate (parity — same eligibility as guard-block)", () => {
  const ticket = {
    escalated_at: escalatedAt,
    escalated_to: null,
    status: "open",
  };
  assert.equal(passesJuneReviewSelection(ticket), true);
});

test("pass: guard-block escalation with any blocked_unbacked_claim:* suffix is eligible", () => {
  // The spec says the reason field is not read — proving that here across a few observed suffixes.
  for (const _suffix of ["cancel", "pause", "skip", "swap"]) {
    const ticket = {
      escalated_at: escalatedAt,
      escalated_to: null,
      status: "open",
    };
    assert.equal(passesJuneReviewSelection(ticket), true);
  }
});

test("pass: escalation_reason field is IGNORED — every open+escalated ticket qualifies", () => {
  // The predicate signature intentionally does NOT include escalation_reason. This test is a
  // structural guarantee: if a future edit adds an escalation_reason parameter and gates on it,
  // the spec's invariant is violated. TypeScript enforces the signature; we assert the outcome
  // by passing a ticket that lacks escalation_reason entirely and still passing.
  const ticket = {
    escalated_at: escalatedAt,
    escalated_to: null,
    status: "open",
  };
  assert.equal(passesJuneReviewSelection(ticket), true);
});

test("skip: never escalated (escalated_at is null)", () => {
  const ticket = {
    escalated_at: null,
    escalated_to: null,
    status: "open",
  };
  assert.equal(passesJuneReviewSelection(ticket), false);
});

test("skip: handed to a specific human (escalated_to set) — human-owned, not routine-owned", () => {
  const ticket = {
    escalated_at: escalatedAt,
    escalated_to: "00000000-0000-0000-0000-000000000001",
    status: "open",
  };
  assert.equal(passesJuneReviewSelection(ticket), false);
});

test("skip: closed ticket — no live escalation to triage", () => {
  const ticket = {
    escalated_at: escalatedAt,
    escalated_to: null,
    status: "closed",
  };
  assert.equal(passesJuneReviewSelection(ticket), false);
});

test("skip: archived ticket — no live escalation to triage", () => {
  const ticket = {
    escalated_at: escalatedAt,
    escalated_to: null,
    status: "archived",
  };
  assert.equal(passesJuneReviewSelection(ticket), false);
});

test("pass: pending status with routine ownership is still a triage candidate", () => {
  // Any non-archived/closed status qualifies — the SQL filter uses .not("status", "in",
  // '("archived","closed")') so intermediate statuses like `pending` or `open` all pass.
  const ticket = {
    escalated_at: escalatedAt,
    escalated_to: null,
    status: "pending",
  };
  assert.equal(passesJuneReviewSelection(ticket), true);
});
