/**
 * Unit test for coraIssuesToMessySignals — the mapping from Cora's own issue taxonomy to the shared
 * coaching vocab, so her no-escalation coaching signals aggregate alongside the cheap pass's.
 *
 * Run:
 *   npx tsx --test src/lib/ticket-analyzer.coachingMap.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { coraIssuesToMessySignals } from "./ticket-analyzer";

test("maps recovered-stumble issue types to the shared vocab", () => {
  const out = coraIssuesToMessySignals([
    { type: "drift" },
    { type: "robotic" },
    { type: "missed_opportunity" },
  ]);
  assert.deepEqual(out.sort(), ["contradiction_recovered", "slow_resolution", "tone_miss_recovered"].sort());
});

test("terminal / unmappable types contribute NO coaching signal", () => {
  // false_promise / broken_action escalate (a bad ending); unverified_from_surface / frustration
  // are not coachable mid-turn slips — none should map.
  assert.deepEqual(
    coraIssuesToMessySignals([{ type: "false_promise" }, { type: "broken_action" }, { type: "unverified_from_surface" }, { type: "frustration" }]),
    [],
  );
});

test("empty issues → empty", () => {
  assert.deepEqual(coraIssuesToMessySignals([]), []);
});
