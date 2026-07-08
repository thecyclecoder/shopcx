/**
 * Pins the Phase 1 gate for docs/brain/specs/cora-only-investigates-after-sol-handles-and-ticket-closed-30min-no-reinvestigation.md:
 * Cora only selects a ticket when Sol has handled it (live Direction exists), its closed_at is
 * >= 30 min ago, and it hasn't already been analyzed for this handling cycle.
 *
 * Run: npx tsx --test src/lib/inngest/ticket-analysis-cron.gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CORA_CLOSE_SETTLE_MS, passesCoraSelectionGate } from "./ticket-analysis-cron";

const NOW = new Date("2026-07-08T12:00:00.000Z");
const iso = (d: Date) => d.toISOString();
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 1000);

test("skip: no live Direction (Sol has not handled)", () => {
  const ticket = { closed_at: iso(minutesAgo(60)), last_analyzed_at: null };
  assert.equal(passesCoraSelectionGate(ticket, null, NOW), false);
});

test("skip: closed_at is null (never closed)", () => {
  const ticket = { closed_at: null, last_analyzed_at: null };
  const direction = { authored_at: iso(minutesAgo(120)) };
  assert.equal(passesCoraSelectionGate(ticket, direction, NOW), false);
});

test("skip: closed_at < 30 min ago (in-flight settle window)", () => {
  const ticket = { closed_at: iso(minutesAgo(29)), last_analyzed_at: null };
  const direction = { authored_at: iso(minutesAgo(120)) };
  assert.equal(passesCoraSelectionGate(ticket, direction, NOW), false);
});

test("pass: closed_at exactly 30 min ago + Sol handled + never analyzed", () => {
  const ticket = {
    closed_at: iso(new Date(NOW.getTime() - CORA_CLOSE_SETTLE_MS)),
    last_analyzed_at: null,
  };
  const direction = { authored_at: iso(minutesAgo(120)) };
  assert.equal(passesCoraSelectionGate(ticket, direction, NOW), true);
});

test("pass: closed_at >> 30 min ago + Sol handled + never analyzed", () => {
  const ticket = { closed_at: iso(minutesAgo(90)), last_analyzed_at: null };
  const direction = { authored_at: iso(minutesAgo(120)) };
  assert.equal(passesCoraSelectionGate(ticket, direction, NOW), true);
});

test("skip: already analyzed at OR after Sol's authored_at (this cycle already graded)", () => {
  const authoredAt = minutesAgo(120);
  const analyzedAt = new Date(authoredAt.getTime() + 60 * 60 * 1000); // 60 min after Sol
  const ticket = { closed_at: iso(minutesAgo(90)), last_analyzed_at: iso(analyzedAt) };
  const direction = { authored_at: iso(authoredAt) };
  assert.equal(passesCoraSelectionGate(ticket, direction, NOW), false);
});

test("skip: last_analyzed_at exactly equals authored_at (still this cycle)", () => {
  const authoredAt = minutesAgo(120);
  const ticket = { closed_at: iso(minutesAgo(90)), last_analyzed_at: iso(authoredAt) };
  const direction = { authored_at: iso(authoredAt) };
  assert.equal(passesCoraSelectionGate(ticket, direction, NOW), false);
});

test("pass: last_analyzed_at is stale — from a PRIOR handling cycle (Sol re-authored)", () => {
  const priorAnalyzedAt = minutesAgo(360); // graded 6h ago (old Sol cycle)
  const newAuthoredAt = minutesAgo(120); // Sol re-handled 2h ago (new cycle)
  const ticket = {
    closed_at: iso(minutesAgo(90)),
    last_analyzed_at: iso(priorAnalyzedAt),
  };
  const direction = { authored_at: iso(newAuthoredAt) };
  assert.equal(passesCoraSelectionGate(ticket, direction, NOW), true);
});

test("skip: garbage closed_at string", () => {
  const ticket = { closed_at: "not-a-date", last_analyzed_at: null };
  const direction = { authored_at: iso(minutesAgo(120)) };
  assert.equal(passesCoraSelectionGate(ticket, direction, NOW), false);
});

// ── Phase 2: June already decided this cycle → skip; new Sol handling re-opens eligibility ──

test("phase2 skip: June decided AFTER Sol's authored_at (current cycle already decided)", () => {
  const authoredAt = minutesAgo(180); // Sol handled 3h ago
  const juneDecidedAt = minutesAgo(90); // June decided 90 min ago (this cycle)
  const ticket = { closed_at: iso(minutesAgo(60)), last_analyzed_at: null };
  const direction = { authored_at: iso(authoredAt) };
  assert.equal(
    passesCoraSelectionGate(ticket, direction, NOW, iso(juneDecidedAt)),
    false,
  );
});

test("phase2 skip: June decided at EXACTLY Sol's authored_at (current cycle boundary)", () => {
  const authoredAt = minutesAgo(180);
  const ticket = { closed_at: iso(minutesAgo(60)), last_analyzed_at: null };
  const direction = { authored_at: iso(authoredAt) };
  assert.equal(
    passesCoraSelectionGate(ticket, direction, NOW, iso(authoredAt)),
    false,
  );
});

test("phase2 pass: June decided in a PRIOR cycle (Sol re-authored past the decision)", () => {
  const priorJuneAt = minutesAgo(360); // June decided 6h ago
  const newAuthoredAt = minutesAgo(120); // Sol re-handled 2h ago (new cycle)
  const ticket = { closed_at: iso(minutesAgo(60)), last_analyzed_at: null };
  const direction = { authored_at: iso(newAuthoredAt) };
  assert.equal(
    passesCoraSelectionGate(ticket, direction, NOW, iso(priorJuneAt)),
    true,
  );
});

test("phase2 pass: no June decision at all (undecided ticket, standard Phase 1 gate)", () => {
  const ticket = { closed_at: iso(minutesAgo(90)), last_analyzed_at: null };
  const direction = { authored_at: iso(minutesAgo(180)) };
  assert.equal(passesCoraSelectionGate(ticket, direction, NOW, null), true);
});

test("phase2 skip: June-decided this cycle beats a stale last_analyzed_at pass", () => {
  // Sanity check: ordering — Phase 2 exclusion still fires even when the last_analyzed_at gate
  // (Phase 1) would pass. A June decision this cycle wins.
  const authoredAt = minutesAgo(180);
  const staleAnalyzedAt = minutesAgo(360); // prior-cycle analyze (would pass Phase 1)
  const juneDecidedAt = minutesAgo(90); // this cycle → Phase 2 fails
  const ticket = { closed_at: iso(minutesAgo(60)), last_analyzed_at: iso(staleAnalyzedAt) };
  const direction = { authored_at: iso(authoredAt) };
  assert.equal(
    passesCoraSelectionGate(ticket, direction, NOW, iso(juneDecidedAt)),
    false,
  );
});
