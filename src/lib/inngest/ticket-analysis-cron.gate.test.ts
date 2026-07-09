/**
 * Pins the Cora selection gate — Phase 2 of
 * docs/brain/specs/cora-grades-on-deterministic-sol-handled-signal-not-brittle-direction-existence.md
 * (retire the Direction-existence dependency; select on the deterministic tickets.sol_handled_at
 * signal instead) — and the pre-existing Phase 1/2 rules from
 * docs/brain/specs/cora-only-investigates-after-sol-handles-and-ticket-closed-30min-no-reinvestigation.md
 * that stay unchanged (30-min settle + per-cycle dedup + June-decided guard).
 *
 * The gate now takes `sol_handled_at` on the ticket row (harness-stamped in
 * scripts/builder-worker.ts runTicketHandleJob on box-session completion) instead of a live
 * `ticket_directions` row. Cora's feeder no longer drops a Sol-handled ticket just because the
 * mid-session writeDirection silently failed under a DB outage.
 *
 * Run: npx tsx --test src/lib/inngest/ticket-analysis-cron.gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CORA_CLOSE_SETTLE_MS, passesCoraSelectionGate } from "./ticket-analysis-cron";

const NOW = new Date("2026-07-08T12:00:00.000Z");
const iso = (d: Date) => d.toISOString();
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 1000);

// ── Phase 2 verification (spec §Phase 2 — Cora selects on sol_handled_at) ──

test("phase2 pass: closed ≥30 min + sol_handled_at set + last_analyzed_at < sol_handled_at → SELECTED (even with NO Direction row)", () => {
  // Verification bullet #1: this is the exact scenario the spec exists for — a Sol-handled
  // ticket the mid-session writeDirection failed silently to record. The deterministic
  // sol_handled_at stamp is the only signal needed.
  const solHandledAt = minutesAgo(120);
  const ticket = {
    closed_at: iso(minutesAgo(45)),
    last_analyzed_at: null,
    sol_handled_at: iso(solHandledAt),
  };
  assert.equal(passesCoraSelectionGate(ticket, NOW, null), true);
});

test("phase2 skip: closed <30 min ago (in-flight settle window) → NOT SELECTED", () => {
  // Verification bullet #2: the 30-min settle stays intact so Cora never grades a rapid-fire
  // conversation still in-flight (customer might still reply 'thanks!' / 'wait, one more thing').
  const ticket = {
    closed_at: iso(minutesAgo(29)),
    last_analyzed_at: null,
    sol_handled_at: iso(minutesAgo(120)),
  };
  assert.equal(passesCoraSelectionGate(ticket, NOW, null), false);
});

test("phase2 skip: already graded this cycle (last_analyzed_at ≥ sol_handled_at) → NOT SELECTED", () => {
  // Verification bullet #3: dedup on sol_handled_at (replaces the prior direction.authored_at
  // dedup). A last_analyzed_at at-or-after sol_handled_at means we already graded THIS Sol
  // handling — skip. A stale last_analyzed_at from a prior Sol handling (before the latest
  // sol_handled_at) is fine — that's covered by the "prior cycle" pass test below.
  const solHandledAt = minutesAgo(120);
  const analyzedAt = new Date(solHandledAt.getTime() + 60 * 60 * 1000); // 60 min after Sol
  const ticket = {
    closed_at: iso(minutesAgo(45)),
    last_analyzed_at: iso(analyzedAt),
    sol_handled_at: iso(solHandledAt),
  };
  assert.equal(passesCoraSelectionGate(ticket, NOW, null), false);
});

test("phase2 skip: sol_handled_at is null (Sol has never handled) → NOT SELECTED", () => {
  // Verification bullet #4: no Sol turn stamped → not eligible. The 'ai' tag pre-filter alone
  // is not the Sol-handled signal (it's a coarse cheap pre-filter); sol_handled_at is the
  // authoritative gate.
  const ticket = {
    closed_at: iso(minutesAgo(60)),
    last_analyzed_at: null,
    sol_handled_at: null,
  };
  assert.equal(passesCoraSelectionGate(ticket, NOW, null), false);
});

// ── Pre-existing edges from the prior spec that must still hold ──

test("skip: closed_at is null (never closed) → NOT SELECTED", () => {
  const ticket = { closed_at: null, last_analyzed_at: null, sol_handled_at: iso(minutesAgo(120)) };
  assert.equal(passesCoraSelectionGate(ticket, NOW, null), false);
});

test("pass: closed_at exactly 30 min ago + sol_handled_at set + never analyzed → SELECTED (settle boundary)", () => {
  const ticket = {
    closed_at: iso(new Date(NOW.getTime() - CORA_CLOSE_SETTLE_MS)),
    last_analyzed_at: null,
    sol_handled_at: iso(minutesAgo(120)),
  };
  assert.equal(passesCoraSelectionGate(ticket, NOW, null), true);
});

test("skip: last_analyzed_at exactly equals sol_handled_at → NOT SELECTED (boundary: still this cycle)", () => {
  const solHandledAt = minutesAgo(120);
  const ticket = {
    closed_at: iso(minutesAgo(45)),
    last_analyzed_at: iso(solHandledAt),
    sol_handled_at: iso(solHandledAt),
  };
  assert.equal(passesCoraSelectionGate(ticket, NOW, null), false);
});

test("pass: last_analyzed_at from a PRIOR handling cycle (Sol re-handled → sol_handled_at advanced) → SELECTED", () => {
  // Sol handled ticket 6h ago, Cora graded that cycle. Sol re-handled 2h ago (new close), and
  // the worker advanced sol_handled_at. Cora must re-grade the new cycle.
  const priorAnalyzedAt = minutesAgo(360);
  const newSolHandledAt = minutesAgo(120);
  const ticket = {
    closed_at: iso(minutesAgo(45)),
    last_analyzed_at: iso(priorAnalyzedAt),
    sol_handled_at: iso(newSolHandledAt),
  };
  assert.equal(passesCoraSelectionGate(ticket, NOW, null), true);
});

test("skip: garbage closed_at string → NOT SELECTED", () => {
  const ticket = { closed_at: "not-a-date", last_analyzed_at: null, sol_handled_at: iso(minutesAgo(120)) };
  assert.equal(passesCoraSelectionGate(ticket, NOW, null), false);
});

// ── June-decided guard (pre-existing Phase 2 of the prior spec) — decided_at vs sol_handled_at ──

test("june-guard skip: June decided AFTER sol_handled_at (current cycle already decided) → NOT SELECTED", () => {
  const solHandledAt = minutesAgo(180);
  const juneDecidedAt = minutesAgo(90);
  const ticket = { closed_at: iso(minutesAgo(60)), last_analyzed_at: null, sol_handled_at: iso(solHandledAt) };
  assert.equal(passesCoraSelectionGate(ticket, NOW, iso(juneDecidedAt)), false);
});

test("june-guard skip: June decided at EXACTLY sol_handled_at (cycle boundary) → NOT SELECTED", () => {
  const solHandledAt = minutesAgo(180);
  const ticket = { closed_at: iso(minutesAgo(60)), last_analyzed_at: null, sol_handled_at: iso(solHandledAt) };
  assert.equal(passesCoraSelectionGate(ticket, NOW, iso(solHandledAt)), false);
});

test("june-guard pass: June decided in a PRIOR cycle (Sol re-handled past the decision) → SELECTED", () => {
  const priorJuneAt = minutesAgo(360);
  const newSolHandledAt = minutesAgo(120);
  const ticket = { closed_at: iso(minutesAgo(60)), last_analyzed_at: null, sol_handled_at: iso(newSolHandledAt) };
  assert.equal(passesCoraSelectionGate(ticket, NOW, iso(priorJuneAt)), true);
});

test("june-guard pass: no June decision at all (undecided ticket) → SELECTED", () => {
  const ticket = { closed_at: iso(minutesAgo(45)), last_analyzed_at: null, sol_handled_at: iso(minutesAgo(180)) };
  assert.equal(passesCoraSelectionGate(ticket, NOW, null), true);
});

test("june-guard skip: June-decided this cycle beats a stale last_analyzed_at pass", () => {
  const solHandledAt = minutesAgo(180);
  const staleAnalyzedAt = minutesAgo(360);
  const juneDecidedAt = minutesAgo(90);
  const ticket = {
    closed_at: iso(minutesAgo(60)),
    last_analyzed_at: iso(staleAnalyzedAt),
    sol_handled_at: iso(solHandledAt),
  };
  assert.equal(passesCoraSelectionGate(ticket, NOW, iso(juneDecidedAt)), false);
});
