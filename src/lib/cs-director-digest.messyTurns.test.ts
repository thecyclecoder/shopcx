/**
 * Unit tests for the `sol_messy_turns` → `early_warning` rollup in June's CS digest (Cora dial-in).
 * Both Cora tiers emit per-ticket coaching signals ([[sol-coaching-signal]]); June aggregates a
 * signal CLASS that recurs across ≥ RECURRING_PROBLEM_THRESHOLD (3) DISTINCT tickets into one
 * early_warning storyline with an `add_rule` proposed fix. Pure helper — no network, no DB.
 *
 * Run:
 *   npx tsx --test src/lib/cs-director-digest.messyTurns.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { composeMessyTurnWarnings } from "./cs-director-digest";

function row(ticketId: string, tier: "cheap" | "cora", signals: string[]) {
  return { id: `act-${ticketId}-${tier}`, reason: "", spec_slug: null, created_at: "2026-07-01T00:00:00Z", metadata: { ticket_id: ticketId, tier, signals } };
}

test("a class on 3 distinct tickets → one early_warning with add_rule", () => {
  const rows = [
    row("t1", "cheap", ["slow_resolution"]),
    row("t2", "cora", ["slow_resolution"]),
    row("t3", "cheap", ["slow_resolution"]),
  ];
  const out = composeMessyTurnWarnings(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "early_warning");
  assert.match(out[0].title, /slow resolution/);
  assert.equal(out[0].proposed_action.type, "add_rule");
  assert.match(out[0].evidence, /3 distinct tickets/);
  assert.match(out[0].evidence, /cheap 2 · cora 1/);
});

test("under threshold → no storyline", () => {
  const out = composeMessyTurnWarnings([
    row("t1", "cheap", ["tone_miss_recovered"]),
    row("t2", "cora", ["tone_miss_recovered"]),
  ]);
  assert.deepEqual(out, []);
});

test("distinct-ticket count, not row count — same ticket many rows does NOT reach 3", () => {
  const out = composeMessyTurnWarnings([
    row("t1", "cheap", ["wrong_tool_recovered"]),
    row("t1", "cora", ["wrong_tool_recovered"]),
    row("t1", "cheap", ["wrong_tool_recovered"]),
  ]);
  assert.deepEqual(out, []); // 3 rows but 1 distinct ticket
});

test("PR2 ladder: cheap_tier_mishandle on 3 distinct tickets → June gets an add_rule permanent-fix storyline", () => {
  // The tiered-remediation ladder logs a `cheap_tier_mishandle` (tier:'cheap') signal every time it
  // re-sessions Sol on a cheap-path mishandle. Once the class recurs, June's digest must roll it up
  // into an early_warning + add_rule — the "June eventually fixes the Sonnet/Haiku portion" loop.
  const out = composeMessyTurnWarnings([
    row("m1", "cheap", ["cheap_tier_mishandle"]),
    row("m2", "cheap", ["cheap_tier_mishandle"]),
    row("m3", "cheap", ["cheap_tier_mishandle"]),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "early_warning");
  assert.match(out[0].title, /cheap tier mishandle/);
  assert.equal(out[0].proposed_action.type, "add_rule");
  assert.match(out[0].evidence, /3 distinct tickets/);
  assert.match(out[0].evidence, /cheap 3 · cora 0/);
});

test("multiple classes are grouped independently; loudest sorts first", () => {
  const rows = [
    row("a", "cora", ["slow_resolution", "tone_miss_recovered"]),
    row("b", "cora", ["slow_resolution"]),
    row("c", "cora", ["slow_resolution"]),
    row("d", "cora", ["slow_resolution"]),
    row("e", "cheap", ["tone_miss_recovered"]),
    row("f", "cheap", ["tone_miss_recovered"]),
  ];
  const out = composeMessyTurnWarnings(rows);
  // slow_resolution on 4 tickets, tone_miss_recovered on 3 → both fire, slow first.
  assert.equal(out.length, 2);
  assert.match(out[0].title, /slow resolution/);
  assert.match(out[0].evidence, /4 distinct tickets/);
  assert.match(out[1].title, /tone miss recovered/);
});
