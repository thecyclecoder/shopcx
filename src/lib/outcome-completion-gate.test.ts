/**
 * Unit tests for the Phase-4 completion gate
 * (docs/brain/specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified.md § Phase 4).
 *
 * Focus: the failing state from ticket 0a9e4d7f (Judy) — a ticket with unverified
 * required_outcome items must NOT auto-resolve. The Phase-4 invariant:
 *   1. `assessOutcomeCompletion` returns `ok=true` iff every row's status is 'verified'.
 *   2. `ok=false` names EVERY unfinished item (pending / done / failed) verbatim so the
 *      escalation reason surfaces them.
 *   3. `verified` is the only closed status — a `done` row (executor fired, DB verify hasn't
 *      confirmed) leaves the ticket in-progress, same as `pending`.
 *   4. A ticket with NO required outcomes passes freely (backward-compatible with the
 *      pre-required_outcomes world — a naked reply-only turn still auto-closes).
 *
 * Run: npx tsx --test src/lib/outcome-completion-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { TicketRequiredOutcome, RequiredOutcomeStatus } from "./ticket-required-outcomes";
import { assessOutcomeCompletion, buildEscalationReason } from "./outcome-completion-gate";

function fakeOutcome(overrides: Partial<TicketRequiredOutcome> & { status: RequiredOutcomeStatus }): TicketRequiredOutcome {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    workspace_id: "w",
    ticket_id: "t",
    direction_id: null,
    kind: "noop",
    description: "noop",
    target_ids: {},
    expected_db_state: {},
    resolution_event_id: null,
    verified_at: null,
    failed_reason: null,
    authored_by: "test",
    authored_at: new Date(0).toISOString(),
    ...overrides,
  };
}

// ── The named failing state (Judy, learning #8) ─────────────────────────

test("Judy failing state: ticket has pending bag + failed credit → BLOCKED, both items named on escalation reason", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add a second bag to next order", status: "pending" }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "apply $15 credit", status: "failed", failed_reason: "coupon executor refused" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, false);
  const unfinished = (verdict as { unfinished_items: Array<{ description: string; status: string }> }).unfinished_items;
  const descs = unfinished.map((u) => u.description).sort();
  assert.deepEqual(descs, ["add a second bag to next order", "apply $15 credit"]);
  const statuses = unfinished.map((u) => u.status).sort();
  assert.deepEqual(statuses, ["failed", "pending"]);
  // Escalation reason must NAME both items (Phase 4 verification bullet 3).
  const reason = buildEscalationReason(verdict);
  assert.match(reason, /add a second bag to next order/);
  assert.match(reason, /apply \$15 credit/);
});

// ── Positive path ───────────────────────────────────────────────────────

test("all outcomes verified → OK (auto-resolve allowed — Phase-4 verification bullet 2)", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add bag", status: "verified", verified_at: new Date().toISOString() }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "$15 credit", status: "verified", verified_at: new Date().toISOString() }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, true);
});

test("empty outcome list → OK (a ticket with no required outcomes still auto-closes — backward compatible)", () => {
  const verdict = assessOutcomeCompletion([]);
  assert.equal(verdict.ok, true);
});

// ── done and failed are BOTH treated as unfinished ──────────────────────

test("any pending outcome → BLOCKED (executor hasn't fired yet)", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "cancel", description: "cancel next box", status: "verified", verified_at: new Date().toISOString() }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "$15 credit", status: "pending" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, false);
  const unfinished = (verdict as { unfinished_items: Array<{ description: string; status: string }> }).unfinished_items;
  assert.equal(unfinished.length, 1);
  assert.equal(unfinished[0].description, "$15 credit");
  assert.equal(unfinished[0].status, "pending");
});

test("any done outcome → BLOCKED (executor fired but DB verify hasn't confirmed — same non-ship-worthy state as pending)", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "apply_coupon", description: "$15 credit", status: "done" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, false, "a done row means the handler returned success but the DB predicate hasn't been confirmed — not ship-worthy");
  const unfinished = (verdict as { unfinished_items: Array<{ status: string }> }).unfinished_items;
  assert.deepEqual(unfinished.map((u) => u.status), ["done"]);
});

test("any failed outcome → BLOCKED with failed_reason preserved on the item", () => {
  const outcomes = [
    fakeOutcome({
      id: "o1",
      kind: "apply_coupon",
      description: "$15 credit",
      status: "failed",
      failed_reason: "coupon executor refused: applied_discounts already contains JUDY15",
    }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, false);
  const unfinished = (verdict as { unfinished_items: Array<{ failed_reason?: string }> }).unfinished_items;
  assert.match(unfinished[0].failed_reason ?? "", /coupon executor refused/);
});

test("mixed pending + done + failed + verified → BLOCKED, all THREE non-verified named", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add bag", status: "pending" }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "$15 credit", status: "done" }),
    fakeOutcome({ id: "o3", kind: "cancel", description: "cancel next box", status: "verified", verified_at: new Date().toISOString() }),
    fakeOutcome({ id: "o4", kind: "partial_refund", description: "$25 refund", status: "failed", failed_reason: "no card on file" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, false);
  const unfinished = (verdict as { unfinished_items: Array<{ description: string }> }).unfinished_items;
  assert.equal(unfinished.length, 3);
  const descs = unfinished.map((u) => u.description).sort();
  assert.deepEqual(descs, ["$15 credit", "$25 refund", "add bag"]);
});

// ── Escalation reason shape ─────────────────────────────────────────────

test("buildEscalationReason: names count + descriptions + statuses", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add bag", status: "pending" }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "$15 credit", status: "failed", failed_reason: "no code" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  const reason = buildEscalationReason(verdict);
  assert.match(reason, /2 required outcome/);
  assert.match(reason, /pending/);
  assert.match(reason, /failed/);
  assert.match(reason, /add bag/);
  assert.match(reason, /\$15 credit/);
});

test("buildEscalationReason on an OK verdict is an empty string (nothing to escalate)", () => {
  const outcomes = [fakeOutcome({ id: "o1", kind: "cancel", description: "cancel", status: "verified", verified_at: new Date().toISOString() })];
  const verdict = assessOutcomeCompletion(outcomes);
  const reason = buildEscalationReason(verdict);
  assert.equal(reason, "");
});

// ── Truncation safety on the reason ─────────────────────────────────────

test("buildEscalationReason: many items → reason stays under the 500-char field cap (tickets.escalation_reason)", () => {
  const outcomes = Array.from({ length: 40 }, (_, i) =>
    fakeOutcome({
      id: `o${i}`,
      kind: "apply_coupon",
      description: `credit item number ${i} with a very long detailed description of what needs to happen`,
      status: "pending",
    }),
  );
  const verdict = assessOutcomeCompletion(outcomes);
  const reason = buildEscalationReason(verdict);
  assert.ok(reason.length <= 500, `reason must fit in escalation_reason (500 char cap), got ${reason.length}`);
  assert.match(reason, /40 required outcome/);
});
