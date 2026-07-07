/**
 * Unit tests for the Phase-3 no-progress circuit predicates in
 * src/lib/no-progress-guard.ts. Pure — no network, no DB. Run:
 *   npx tsx --test src/lib/no-progress-guard.test.ts
 *
 * Named failing state (spec Phase-3 verification): "A no-progress ticket
 * stops escalating context/model and is surfaced instead of silently
 * re-charged." The predicates must count consecutive inbound customer
 * messages back to the last outbound reply or executed action — an
 * outbound OR an action resets the streak, non-action system notes
 * (routing / merges) are transparent to the count.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  inboundStreakSinceLastResponse,
  shouldTripNoProgressCircuit,
  NO_PROGRESS_M,
  type StreakMessage,
} from "./no-progress-guard";

const inbound = (body = "hi"): StreakMessage =>
  ({ direction: "inbound", author_type: "customer", body });
const outbound = (body = "reply"): StreakMessage =>
  ({ direction: "outbound", author_type: "agent", body });
const sysAction = (body: string): StreakMessage =>
  ({ direction: "outbound", author_type: "system", body, visibility: "internal" });
const sysNote = (body: string): StreakMessage =>
  ({ direction: "outbound", author_type: "system", body, visibility: "internal" });

test("no inbound tail → streak = 0 → circuit does not trip", () => {
  const s = inboundStreakSinceLastResponse([outbound(), inbound(), outbound()]);
  assert.equal(s, 0);
  assert.equal(shouldTripNoProgressCircuit(s), false);
});

test("one inbound at tail → streak = 1 → below threshold", () => {
  const s = inboundStreakSinceLastResponse([outbound(), inbound()]);
  assert.equal(s, 1);
  assert.equal(shouldTripNoProgressCircuit(s), false);
});

test("M inbound at tail with no outbound reset → streak = M → CIRCUIT TRIPS (named failing state)", () => {
  const s = inboundStreakSinceLastResponse([
    outbound(),
    inbound("first stuck"),
    inbound("second stuck"),
    inbound("third stuck"),
  ]);
  assert.equal(s, NO_PROGRESS_M);
  assert.equal(shouldTripNoProgressCircuit(s), true);
});

test("action-executed system note resets the streak (real state change)", () => {
  const s = inboundStreakSinceLastResponse([
    inbound("one"),
    inbound("two"),
    sysAction("Action completed: refund $42"),
    inbound("thanks — one more thing"),
  ]);
  assert.equal(s, 1, "only the post-action inbound counts");
  assert.equal(shouldTripNoProgressCircuit(s), false);
});

test("non-action system note is transparent (routing / model-picker notes don't reset)", () => {
  const s = inboundStreakSinceLastResponse([
    inbound("one"),
    sysNote("[System] Orchestrator model: opus (turn>=1)"),
    inbound("two"),
    inbound("three"),
  ]);
  assert.equal(s, 3, "routing notes must not mask a genuine no-progress streak");
  assert.equal(shouldTripNoProgressCircuit(s), true);
});

test("outbound reply resets the streak — a real response counts as progress", () => {
  const s = inboundStreakSinceLastResponse([
    inbound("one"),
    inbound("two"),
    outbound("Sorry — I hear you"),
    inbound("thanks"),
  ]);
  assert.equal(s, 1);
});

test("threshold constant is 3 (documented) — regressions on M require test churn", () => {
  assert.equal(NO_PROGRESS_M, 3);
});
