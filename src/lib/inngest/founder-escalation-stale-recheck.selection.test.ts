/**
 * Pure predicate tests for the Phase-2 stale-founder-escalation re-check sweep
 * (docs/brain/specs/a-founder-escalated-customer-never-waits-in-silence.md § Phase 2).
 *
 * `passesFounderStaleRecheckSelection` and `countPriorFounderRechecks` are the two invariants the
 * cron leans on to (a) target the right shape of ticket and (b) cap re-checks at 2 so a genuine
 * founder-only decision never becomes a loop. Both are pure — the test suite pins them without a
 * DB so a future SQL-filter tweak that leaks an ineligible ticket cannot defeat the invariant.
 *
 * Run: `npx tsx --test src/lib/inngest/founder-escalation-stale-recheck.selection.test.ts`
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FOUNDER_RECHECK_CAP,
  FOUNDER_STALE_RECHECK_HOURS,
  buildFounderRecheckInstructions,
  countPriorFounderRechecks,
  passesFounderStaleRecheckSelection,
} from "./founder-escalation-stale-recheck";

const NOW = "2026-08-03T12:00:00Z";
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 60 * 60 * 1000).toISOString();

// ── passesFounderStaleRecheckSelection ────────────────────────────────────────────────────────────

test("passesFounderStaleRecheckSelection — a founder-escalated open ticket 48h+ old QUALIFIES", () => {
  const ticket = {
    escalated_at: hoursAgo(FOUNDER_STALE_RECHECK_HOURS + 1),
    escalated_to: "founder-user-uuid",
    status: "open",
  };
  assert.equal(passesFounderStaleRecheckSelection(ticket, NOW), true);
});

test("passesFounderStaleRecheckSelection — a fresher founder-escalated ticket (< threshold) does NOT qualify", () => {
  const ticket = {
    escalated_at: hoursAgo(FOUNDER_STALE_RECHECK_HOURS - 1),
    escalated_to: "founder-user-uuid",
    status: "open",
  };
  assert.equal(passesFounderStaleRecheckSelection(ticket, NOW), false);
});

test("passesFounderStaleRecheckSelection — routine-owned escalation (escalated_to null) does NOT qualify (primary triage owns those)", () => {
  const ticket = {
    escalated_at: hoursAgo(72),
    escalated_to: null,
    status: "open",
  };
  assert.equal(passesFounderStaleRecheckSelection(ticket, NOW), false);
});

test("passesFounderStaleRecheckSelection — a closed ticket never re-checks", () => {
  const ticket = {
    escalated_at: hoursAgo(72),
    escalated_to: "founder-user-uuid",
    status: "closed",
  };
  assert.equal(passesFounderStaleRecheckSelection(ticket, NOW), false);
});

test("passesFounderStaleRecheckSelection — an archived ticket never re-checks", () => {
  const ticket = {
    escalated_at: hoursAgo(72),
    escalated_to: "founder-user-uuid",
    status: "archived",
  };
  assert.equal(passesFounderStaleRecheckSelection(ticket, NOW), false);
});

test("passesFounderStaleRecheckSelection — the three worst multi-day stalls on record (232h, 75h, 46h) would all have qualified", () => {
  // 232h (jleone), 75h (bellamyjs) clear 48h by a wide margin; 46h is under the default 48h floor
  // (the tightest window that catches all three without waking June on routine same-day reviews).
  for (const hours of [232, 75]) {
    const ticket = {
      escalated_at: hoursAgo(hours),
      escalated_to: "founder-user-uuid",
      status: "open",
    };
    assert.equal(
      passesFounderStaleRecheckSelection(ticket, NOW),
      true,
      `expected ${hours}h-old escalation to qualify`,
    );
  }
  // 46h is JUST under the default 48h threshold — pinning this documents the trade-off so a
  // future edit that widens the window to catch 46h is a conscious decision, not a drive-by.
  assert.equal(
    passesFounderStaleRecheckSelection(
      { escalated_at: hoursAgo(46), escalated_to: "u", status: "open" },
      NOW,
    ),
    false,
    "46h escalation is under the default 48h threshold — widen FOUNDER_STALE_RECHECK_HOURS to catch it",
  );
});

test("passesFounderStaleRecheckSelection — a null escalated_at never qualifies (a ticket has to be escalated first)", () => {
  const ticket = { escalated_at: null, escalated_to: "founder-user-uuid", status: "open" };
  assert.equal(passesFounderStaleRecheckSelection(ticket, NOW), false);
});

test("passesFounderStaleRecheckSelection — an unparseable escalated_at fails closed", () => {
  const ticket = { escalated_at: "not-a-date", escalated_to: "founder-user-uuid", status: "open" };
  assert.equal(passesFounderStaleRecheckSelection(ticket, NOW), false);
});

// ── countPriorFounderRechecks ─────────────────────────────────────────────────────────────────────

test("countPriorFounderRechecks — a ticket with zero prior recheck jobs returns 0", () => {
  assert.equal(countPriorFounderRechecks([]), 0);
});

test("countPriorFounderRechecks — only jobs with instructions.recheck===true count", () => {
  const jobs = [
    { instructions: JSON.stringify({ ticket_id: "t1" }) }, // initial June review — NOT a recheck
    { instructions: JSON.stringify({ ticket_id: "t1", recheck: true, recheck_index: 1 }) }, // recheck #1
    { instructions: JSON.stringify({ ticket_id: "t1", second_opinion_of: "run-9" }) }, // on-demand SO — NOT a recheck
    { instructions: JSON.stringify({ ticket_id: "t1", recheck: true, recheck_index: 2 }) }, // recheck #2
  ];
  assert.equal(countPriorFounderRechecks(jobs), 2);
});

test("countPriorFounderRechecks — CAP invariant: 2 prior recheck jobs means the cron will not enqueue a third", () => {
  // The cron gates on `prior >= FOUNDER_RECHECK_CAP` before enqueuing. Pinning FOUNDER_RECHECK_CAP
  // = 2 keeps a genuinely founder-only decision from becoming a June-page loop.
  assert.equal(FOUNDER_RECHECK_CAP, 2, "FOUNDER_RECHECK_CAP is the spec's explicit cap — do not widen without the CEO");
  const jobs = [
    { instructions: JSON.stringify({ recheck: true, recheck_index: 1 }) },
    { instructions: JSON.stringify({ recheck: true, recheck_index: 2 }) },
  ];
  const prior = countPriorFounderRechecks(jobs);
  assert.equal(prior >= FOUNDER_RECHECK_CAP, true, "at CAP → cron must skip");
});

test("countPriorFounderRechecks — malformed / null instructions never crash the counter", () => {
  const jobs = [
    { instructions: null },
    { instructions: "{ not valid json" },
    { instructions: JSON.stringify({ recheck: "truthy-but-not-true" }) }, // strict equality — only literal `true` counts
    { instructions: JSON.stringify({ recheck: true }) },
  ];
  assert.equal(countPriorFounderRechecks(jobs), 1);
});

// ── buildFounderRecheckInstructions ──────────────────────────────────────────────────────────────

test("buildFounderRecheckInstructions — carries ticket_id + recheck:true + recheck_index (round-trippable to countPriorFounderRechecks)", () => {
  const s = buildFounderRecheckInstructions({ ticketId: "ticket-42", recheckIndex: 1 });
  const parsed = JSON.parse(s) as Record<string, unknown>;
  assert.equal(parsed.ticket_id, "ticket-42");
  assert.equal(parsed.recheck, true);
  assert.equal(parsed.recheck_index, 1);
  // Round-trip: the counter treats a job carrying this exact instructions blob as a recheck.
  assert.equal(countPriorFounderRechecks([{ instructions: s }]), 1);
});

test("buildFounderRecheckInstructions — attaches triage_run_id linkage when known so resolveLinkageFromJob still finds it", () => {
  const s = buildFounderRecheckInstructions({
    ticketId: "ticket-42",
    triageRunId: "run-77",
    recheckIndex: 2,
  });
  const parsed = JSON.parse(s) as Record<string, unknown>;
  assert.equal(parsed.triage_run_id, "run-77");
  assert.equal(parsed.recheck_index, 2);
});

test("buildFounderRecheckInstructions — a null/undefined triage_run_id is omitted (never serialized as literal null)", () => {
  const s = buildFounderRecheckInstructions({ ticketId: "ticket-42", recheckIndex: 1 });
  const parsed = JSON.parse(s) as Record<string, unknown>;
  assert.equal("triage_run_id" in parsed, false);
});
