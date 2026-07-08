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

// ── Phase 2 of sol-closes-ticket-on-resolving-reply-so-cora-grades-it ──
// Verification #3: a Sol-closed ticket is enqueued for ticket-analyze (Cora grades it). This
// pins the end-to-end shape by exercising `passesCoraSelectionGate` with the exact row shape
// Sol's Phase-1 close produces: status='closed', closed_at=now, a live Direction written when
// Sol authored the first-touch. After the 30-min settle, Cora selects the ticket. Without the
// Phase-1 close (status='open', closed_at=null), Cora never selects it — which is the whole
// motivation for this spec.

test("sol-closes-spec: a Sol-closed ticket (closed_at 31min ago + live Direction) PASSES the gate → Cora enqueues", () => {
  // Sol's box session wrote the Direction, sent the resolving reply, and the Phase-1 close
  // helper set closed_at. 31 min later Cora's 30-min cron sweep selects the ticket.
  const solAuthoredAt = minutesAgo(45); // Sol wrote the Direction 45 min ago
  const solClosedAt = minutesAgo(31); // Sol closed 31 min ago (just past the 30-min settle)
  const ticket = { closed_at: iso(solClosedAt), last_analyzed_at: null };
  const direction = { authored_at: iso(solAuthoredAt) };
  assert.equal(passesCoraSelectionGate(ticket, direction, NOW, null), true);
});

test("sol-closes-spec: same ticket BEFORE Phase-1 close landed (closed_at=null) is SKIPPED → Cora never enqueues", () => {
  // This is the exact bug the spec fixes: a Sol turn that sent a resolving reply but never
  // closed the ticket leaves closed_at=null, so Cora's gate rejects it forever. This test
  // proves the pre-Phase-1 regression state (Cora silent on unclosed Sol tickets).
  const solAuthoredAt = minutesAgo(45);
  const ticket = { closed_at: null, last_analyzed_at: null };
  const direction = { authored_at: iso(solAuthoredAt) };
  assert.equal(passesCoraSelectionGate(ticket, direction, NOW, null), false);
});
