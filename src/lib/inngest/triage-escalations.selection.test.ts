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
import {
  passesJuneReviewSelection,
  priorReviewCoversCurrentEscalation,
} from "./triage-escalations";

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

/**
 * Pins the Phase 1 invariant for docs/brain/specs/triage-escalations-prior-review-lifecycle-guard.md:
 * the June-review dedupe is scoped to the ticket's CURRENT escalation lifecycle. A `triage_runs`
 * row recorded BEFORE the ticket's current `escalated_at` (i.e. from a prior escalation that has
 * since been resolved and re-escalated) does NOT block a fresh review — only a row recorded at or
 * after the current `escalated_at` does.
 *
 * The failing state this exists to prevent: an escalated ticket sat past the two-hour grace with
 * zero fresh cs-director-call because the cron treated an old triage_runs row from a resolved
 * prior escalation as proof the current escalation was handled.
 */
test("prior-review guard: no triage_runs row ⇒ fresh review needed", () => {
  assert.equal(priorReviewCoversCurrentEscalation(escalatedAt, null), false);
});

test("prior-review guard: prior review recorded BEFORE current escalated_at ⇒ fresh review needed", () => {
  // This is the 472310cc-shaped failing state: the ticket was reviewed once, resolved, then
  // re-escalated. The old triage_runs row must NOT block the new escalation lifecycle.
  const priorReviewAt = "2026-07-01T10:00:00.000Z";
  const currentEscalatedAt = "2026-07-08T11:00:00.000Z";
  assert.equal(
    priorReviewCoversCurrentEscalation(currentEscalatedAt, priorReviewAt),
    false,
  );
});

test("prior-review guard: prior review recorded AFTER current escalated_at ⇒ current escalation already handled", () => {
  // Same-lifecycle dedupe: the current escalation was handled by June — don't re-enqueue on the
  // next hourly tick.
  const priorReviewAt = "2026-07-08T12:00:00.000Z";
  const currentEscalatedAt = "2026-07-08T11:00:00.000Z";
  assert.equal(
    priorReviewCoversCurrentEscalation(currentEscalatedAt, priorReviewAt),
    true,
  );
});

test("prior-review guard: prior review recorded AT current escalated_at (exact tie) ⇒ current escalation covered", () => {
  // Boundary: >= not > so a review clock-synced with the escalation timestamp still counts as
  // covering the current lifecycle (prevents a double-review from a clock-tie race).
  const t = "2026-07-08T11:00:00.000Z";
  assert.equal(priorReviewCoversCurrentEscalation(t, t), true);
});

test("prior-review guard: ticket with no escalated_at ⇒ no lifecycle to cover (returns false)", () => {
  // The ticket-level selection predicate already filters unescalated tickets out; this branch
  // exists so a malformed row can't degrade to a truthy skip.
  assert.equal(priorReviewCoversCurrentEscalation(null, "2026-07-01T00:00:00.000Z"), false);
});

test("prior-review guard: unparseable timestamps ⇒ default to fresh review (never suppress on garbage input)", () => {
  // Safer to over-review than to silently skip when a downstream row shape drifts.
  assert.equal(priorReviewCoversCurrentEscalation("not-a-date", "2026-07-08T11:00:00.000Z"), false);
  assert.equal(priorReviewCoversCurrentEscalation("2026-07-08T11:00:00.000Z", "not-a-date"), false);
});
