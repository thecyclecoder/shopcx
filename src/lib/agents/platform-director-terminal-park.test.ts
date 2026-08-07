/**
 * one-open-escalation-per-thing Phase 2 — pins the NAMED FAILING STATE for the terminal-subject skip.
 *
 * The 2026-07-28 incident: 50 parked `cs-director-call` jobs pointed at tickets closed HOURS earlier
 * and were re-escalated every sweep. The fix is a pure predicate the sweep runs before escalating: if
 * the job's subject is TERMINAL (closed/archived/resolved ticket, folded/shipped spec) OR the park is
 * older than the stale window and never actionable, CANCEL the job — its subject cannot be resolved
 * by retrying, so the job leaves needs_attention and never re-escalates.
 *
 * Two pure predicates cover the whole decision without a Supabase seam:
 *   - computeTerminalSubjectSkip(subject) → terminal:true|false + reason
 *   - computeAgeOutSkip(createdAt, hasTriageLedgerRow, nowMs) → ageOut:true|false + reason
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/agents/platform-director-terminal-park.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeTerminalSubjectSkip,
  computeAgeOutSkip,
  NEEDS_ATTENTION_STALE_PARK_MS,
} from "./platform-director";

const NOW_MS = Date.parse("2026-07-28T12:00:00Z");

// ── computeTerminalSubjectSkip — the terminal-subject predicate ─────────────────────────────

test("computeTerminalSubjectSkip — closed ticket → terminal (the 2026-07-28 exact case: 50 parks on closed tickets)", () => {
  const decision = computeTerminalSubjectSkip({ ticketStatus: "closed" });
  assert.equal(decision.terminal, true);
  if (decision.terminal) assert.match(decision.reason, /ticket already closed/);
});

test("computeTerminalSubjectSkip — resolved ticket → terminal (current tickets CHECK constraint accepts 'resolved')", () => {
  const decision = computeTerminalSubjectSkip({ ticketStatus: "resolved" });
  assert.equal(decision.terminal, true);
  if (decision.terminal) assert.match(decision.reason, /ticket already resolved/);
});

test("computeTerminalSubjectSkip — archived ticket → terminal (spec-named terminal even if schema is currently silent on it)", () => {
  const decision = computeTerminalSubjectSkip({ ticketStatus: "archived" });
  assert.equal(decision.terminal, true);
});

test("computeTerminalSubjectSkip — open ticket → NOT terminal (a still-live ticket must reach the sweep's normal path)", () => {
  const decision = computeTerminalSubjectSkip({ ticketStatus: "open" });
  assert.equal(decision.terminal, false);
});

test("computeTerminalSubjectSkip — pending ticket → NOT terminal (a customer response is still expected)", () => {
  const decision = computeTerminalSubjectSkip({ ticketStatus: "pending" });
  assert.equal(decision.terminal, false);
});

test("computeTerminalSubjectSkip — folded spec → terminal (its brain page is retired; the job's subject no longer exists)", () => {
  const decision = computeTerminalSubjectSkip({ specStatus: "folded" });
  assert.equal(decision.terminal, true);
  if (decision.terminal) assert.match(decision.reason, /spec already folded/);
});

test("computeTerminalSubjectSkip — shipped spec → terminal (the parent finished; a QC park on a shipped spec is orphaned)", () => {
  const decision = computeTerminalSubjectSkip({ specStatus: "shipped" });
  assert.equal(decision.terminal, true);
});

test("computeTerminalSubjectSkip — in_progress spec → NOT terminal (the work is still live; the park has an owner)", () => {
  const decision = computeTerminalSubjectSkip({ specStatus: "in_progress" });
  assert.equal(decision.terminal, false);
});

test("computeTerminalSubjectSkip — no subject resolvable (parked job with no ticket or spec) → NOT terminal (fall through to escalate path — never a silent suppress)", () => {
  const decision = computeTerminalSubjectSkip({});
  assert.equal(decision.terminal, false);
});

test("computeTerminalSubjectSkip — ticket takes precedence over spec on cs-director-call (ticket status wins when both present)", () => {
  // A cs-director-call has both a ticket AND (typically) no spec, but if a caller ever hands both,
  // ticket wins because that's the primary subject the customer cares about.
  const decision = computeTerminalSubjectSkip({ ticketStatus: "closed", specStatus: "in_progress" });
  assert.equal(decision.terminal, true);
  if (decision.terminal) assert.match(decision.reason, /ticket already closed/);
});

// ── computeAgeOutSkip — the age-out predicate ────────────────────────────────────────────────

test("computeAgeOutSkip — park older than the stale window with no ledger row → ageOut (dead residue)", () => {
  const createdAt = new Date(NOW_MS - (NEEDS_ATTENTION_STALE_PARK_MS + 60_000)).toISOString();
  const decision = computeAgeOutSkip(createdAt, false, NOW_MS);
  assert.equal(decision.ageOut, true);
  if (decision.ageOut) assert.match(decision.reason, /never escalated, never re-runnable/);
});

test("computeAgeOutSkip — park older than the stale window WITH a ledger row → NOT ageOut (an escalation is in flight — don't override the CEO)", () => {
  const createdAt = new Date(NOW_MS - (NEEDS_ATTENTION_STALE_PARK_MS + 60_000)).toISOString();
  const decision = computeAgeOutSkip(createdAt, true, NOW_MS);
  assert.equal(decision.ageOut, false);
});

test("computeAgeOutSkip — park younger than the stale window → NOT ageOut (regardless of ledger)", () => {
  const createdAt = new Date(NOW_MS - (NEEDS_ATTENTION_STALE_PARK_MS - 60_000)).toISOString();
  assert.equal(computeAgeOutSkip(createdAt, false, NOW_MS).ageOut, false);
  assert.equal(computeAgeOutSkip(createdAt, true, NOW_MS).ageOut, false);
});

test("computeAgeOutSkip — the reason string includes the hours-since-park (the CEO can tell why it aged out)", () => {
  const createdAt = new Date(NOW_MS - 48 * 60 * 60 * 1000).toISOString(); // 48h ago
  const decision = computeAgeOutSkip(createdAt, false, NOW_MS);
  assert.equal(decision.ageOut, true);
  if (decision.ageOut) assert.match(decision.reason, /parked 48h/);
});

test("computeAgeOutSkip — a custom windowMs override honours the caller's choice (per-lane tuning path)", () => {
  const createdAt = new Date(NOW_MS - 90 * 60 * 1000).toISOString(); // 90 min ago
  // Default 24h window → not yet.
  assert.equal(computeAgeOutSkip(createdAt, false, NOW_MS).ageOut, false);
  // Custom 60 min window → aged out.
  assert.equal(computeAgeOutSkip(createdAt, false, NOW_MS, 60 * 60 * 1000).ageOut, true);
});

// ── security-dep-watch-authors-structured-and-never-ages-out Phase 3 ────────────────────────
// The 2026-07-21 exact case: a dep-watch park sat 310h with 3 actionable advisories, never
// escalated, and was CANCELLED for aging out. Silently discarding a security finding because
// it got old is the failure mode most likely to hurt us — a security-lane park must NEVER
// age-out; it escalates through the standard path instead.

test("computeAgeOutSkip — security-lane park past the stale window → NOT ageOut (the 2026-07-21 exact case: 310h dep-watch park)", () => {
  const createdAt = new Date(NOW_MS - 310 * 60 * 60 * 1000).toISOString(); // 310h, the incident's exact age
  const decision = computeAgeOutSkip(createdAt, false, NOW_MS, undefined, { securityLane: true });
  assert.equal(decision.ageOut, false);
  // The exemption carries a documented reason so the caller can surface WHY the sweep skipped
  // (the dep-watch caller uses it to escalate on age rather than cancel).
  if (!decision.ageOut) assert.match(decision.exemptReason ?? "", /security.*never ages? out/i);
});

test("computeAgeOutSkip — non-security lane past the stale window (unchanged): STILL ages out (regression pin — the exemption is scoped to security parks only)", () => {
  const createdAt = new Date(NOW_MS - 310 * 60 * 60 * 1000).toISOString();
  const decision = computeAgeOutSkip(createdAt, false, NOW_MS, undefined, { securityLane: false });
  assert.equal(decision.ageOut, true);
});

test("computeAgeOutSkip — no opts arg (all existing callers stay green): STILL ages out past the window", () => {
  const createdAt = new Date(NOW_MS - 310 * 60 * 60 * 1000).toISOString();
  const decision = computeAgeOutSkip(createdAt, false, NOW_MS);
  assert.equal(decision.ageOut, true);
});
