/**
 * Unit tests for the shared coaching-signal vocab + the Cora-issue→messy-signal mapping.
 *
 * Run:
 *   npx tsx --test src/lib/sol-coaching-signal.test.ts src/lib/ticket-analyzer.coachingMap.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMessyTurnSignals, SOL_MESSY_TURN_SIGNALS } from "./sol-coaching-signal";

test("normalize keeps known signals, dedupes, drops unknown", () => {
  assert.deepEqual(
    normalizeMessyTurnSignals(["slow_resolution", "slow_resolution", "bogus", "tone_miss_recovered"]),
    ["slow_resolution", "tone_miss_recovered"],
  );
});

test("normalize handles null / non-array / empty", () => {
  assert.deepEqual(normalizeMessyTurnSignals(null), []);
  assert.deepEqual(normalizeMessyTurnSignals(undefined), []);
  assert.deepEqual(normalizeMessyTurnSignals([]), []);
  assert.deepEqual(normalizeMessyTurnSignals([1, 2, {}] as unknown as string[]), []);
});

test("vocab is all recovered-stumble classes — no terminal-failure classes leak in", () => {
  // Terminal failures (which escalate) must never be in the coaching vocab.
  for (const terminal of ["customer_unresolved", "false_outcome_claim", "false_promise", "broken_action"]) {
    assert.ok(!SOL_MESSY_TURN_SIGNALS.includes(terminal as never), `${terminal} must not be a coaching signal`);
  }
});
