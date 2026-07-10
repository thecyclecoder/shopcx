/**
 * Pins the Cora selection gate.
 *
 * cora-grades-every-ai-handled-ticket-not-just-sol (this change): the gate selects on the
 * deterministic HANDLED stamps — `ai_handled_at` (any AI tier: Sonnet/Haiku orchestrator, Sol,
 * journey, playbook — all stamp it in deliverTicketMessage) OR `sol_handled_at` (the Sol-specific
 * sub-flag). Either present ⇒ we handled it ⇒ grade it, so the cheap autonomous path is graded too,
 * not just Sol sessions. The old `ai`-tag AND-gate is gone. Settle keys on the LAST CUSTOMER
 * MESSAGE (not closed_at), and a ticket with NO customer message (outbound-only) is excluded.
 *
 * Retains the pre-existing rules: 30-min settle, per-cycle dedup on the handling anchor, and the
 * June-decided guard (cora-only-investigates-after-sol-handles-and-ticket-closed-30min).
 *
 * Run: npx tsx --test src/lib/inngest/ticket-analysis-cron.gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CORA_CLOSE_SETTLE_MS, passesCoraSelectionGate } from "./ticket-analysis-cron";

const NOW = new Date("2026-07-08T12:00:00.000Z");
const iso = (d: Date) => d.toISOString();
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 1000);

type GateTicket = Parameters<typeof passesCoraSelectionGate>[0];
/** Build a ticket that PASSES by default; override per test. Sol-handled 120m ago, customer's
 *  last message 45m ago (settled), closed, never analyzed. */
function ticket(over: Partial<GateTicket> = {}): GateTicket {
  return {
    closed_at: iso(minutesAgo(45)),
    last_analyzed_at: null,
    sol_handled_at: iso(minutesAgo(120)),
    ai_handled_at: iso(minutesAgo(120)),
    last_customer_message_at: iso(minutesAgo(45)),
    ...over,
  };
}

// ── The core new behavior: grade the cheap path (ai_handled_at, no Sol) ──

test("CHEAP-HANDLED (ai_handled_at set, sol_handled_at NULL) → SELECTED", () => {
  // Sonnet/Haiku handled it, Sol never did. This is the whole point — the low-cost autonomous
  // path must be graded too, not just Sol sessions.
  assert.equal(passesCoraSelectionGate(ticket({ sol_handled_at: null, ai_handled_at: iso(minutesAgo(120)) }), NOW, null), true);
});

test("SOL-HANDLED only (sol_handled_at set, ai_handled_at NULL) → SELECTED", () => {
  assert.equal(passesCoraSelectionGate(ticket({ sol_handled_at: iso(minutesAgo(120)), ai_handled_at: null }), NOW, null), true);
});

test("NEITHER stamp (never handled) → NOT SELECTED", () => {
  assert.equal(passesCoraSelectionGate(ticket({ sol_handled_at: null, ai_handled_at: null }), NOW, null), false);
});

// ── Outbound exclusion: no customer message ⇒ not a graded conversation ──

test("OUTBOUND (ai_handled_at set but NO customer message) → NOT SELECTED", () => {
  // A dunning email we sent that the customer never replied to. It may carry ai_handled_at, but
  // with no inbound it is not a handled conversation — must never leak into grading.
  assert.equal(passesCoraSelectionGate(ticket({ last_customer_message_at: null }), NOW, null), false);
});

// ── Settle keys on the LAST CUSTOMER MESSAGE, not closed_at ──

test("settle skip: customer's last message <30 min ago (still in-flight) → NOT SELECTED, even if closed long ago", () => {
  assert.equal(passesCoraSelectionGate(ticket({ closed_at: iso(minutesAgo(200)), last_customer_message_at: iso(minutesAgo(29)) }), NOW, null), false);
});

test("settle pass: closed only 5 min ago BUT customer last spoke 40 min ago → SELECTED", () => {
  // The old closed_at settle would have wrongly skipped this; keying on the customer's last
  // message grades it, since the customer has clearly moved on.
  assert.equal(passesCoraSelectionGate(ticket({ closed_at: iso(minutesAgo(5)), last_customer_message_at: iso(minutesAgo(40)) }), NOW, null), true);
});

test("settle boundary: customer last message EXACTLY 30 min ago → SELECTED", () => {
  assert.equal(passesCoraSelectionGate(ticket({ last_customer_message_at: iso(new Date(NOW.getTime() - CORA_CLOSE_SETTLE_MS)) }), NOW, null), true);
});

test("skip: not closed (closed_at null) → NOT SELECTED", () => {
  assert.equal(passesCoraSelectionGate(ticket({ closed_at: null }), NOW, null), false);
});

test("skip: garbage last_customer_message_at → NOT SELECTED", () => {
  assert.equal(passesCoraSelectionGate(ticket({ last_customer_message_at: "not-a-date" }), NOW, null), false);
});

// ── Dedup on the handling anchor (later of ai/sol) ──

test("dedup skip: already graded this cycle (last_analyzed_at ≥ handling anchor) → NOT SELECTED", () => {
  const handled = minutesAgo(120);
  const analyzedAfter = new Date(handled.getTime() + 60 * 60 * 1000);
  assert.equal(passesCoraSelectionGate(ticket({ sol_handled_at: iso(handled), ai_handled_at: iso(handled), last_analyzed_at: iso(analyzedAfter) }), NOW, null), false);
});

test("dedup pass: last_analyzed_at from a PRIOR handling (re-handled → anchor advanced) → SELECTED", () => {
  assert.equal(passesCoraSelectionGate(ticket({ sol_handled_at: iso(minutesAgo(120)), ai_handled_at: iso(minutesAgo(120)), last_analyzed_at: iso(minutesAgo(360)) }), NOW, null), true);
});

test("anchor = LATER of the two stamps: dedup uses the newer handling", () => {
  // ai_handled_at is newer (re-handled cheaply after an old Sol turn). last_analyzed_at is after
  // the old Sol turn but before the new ai turn → this new cycle is ungraded → SELECTED.
  assert.equal(passesCoraSelectionGate(ticket({
    sol_handled_at: iso(minutesAgo(300)),
    ai_handled_at: iso(minutesAgo(120)),
    last_analyzed_at: iso(minutesAgo(240)),
  }), NOW, null), true);
});

// ── June-decided guard (decided_at vs the handling anchor) ──

test("june-guard skip: June decided AFTER the handling anchor (cycle already decided) → NOT SELECTED", () => {
  assert.equal(passesCoraSelectionGate(ticket({ sol_handled_at: iso(minutesAgo(180)), ai_handled_at: iso(minutesAgo(180)) }), NOW, iso(minutesAgo(90))), false);
});

test("june-guard pass: June decided in a PRIOR cycle (re-handled past it) → SELECTED", () => {
  assert.equal(passesCoraSelectionGate(ticket({ sol_handled_at: iso(minutesAgo(120)), ai_handled_at: iso(minutesAgo(120)) }), NOW, iso(minutesAgo(360))), true);
});

test("june-guard pass: no June decision at all → SELECTED", () => {
  assert.equal(passesCoraSelectionGate(ticket(), NOW, null), true);
});
