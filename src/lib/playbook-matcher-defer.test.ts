/**
 * Unit tests for the playbook-compiler loop § Phase 3 —
 * matcher-defers-on-uncertainty + fail-fast escalation
 * (spec: playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks).
 *
 * Pins:
 *   (a) `scorePlaybookAgainst` — the pure scoring function returns
 *       score ~ 0.55 when the ONLY trigger match is a reverse-substring
 *       ("melted_in_transit_full" contains "melted_in_transit"), and
 *       ~0.85 when the intent has a full-substring match on a trigger.
 *   (b) `applyDeferThreshold` — top_score=0.55 below the default
 *       DEFAULT_DEFER_THRESHOLD (0.65) → returns null (defer), while
 *       top_score=0.85 → returns the match unchanged.
 *   (c) `assertPlaybookStepConfidence` — chosenConfidence=0.4 below
 *       DEFAULT_FAIL_FAST_THRESHOLD (0.5) → escalate fires with
 *       reason='playbook_low_confidence' AND `stopped=true` so the
 *       caller bails; chosenConfidence=0.6 → escalate is NEVER called
 *       and `stopped=false` so the step engine continues.
 *
 * Run: `npx tsx --test src/lib/playbook-matcher-defer.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  scorePlaybookAgainst,
  applyDeferThreshold,
  assertPlaybookStepConfidence,
  DEFAULT_DEFER_THRESHOLD,
  DEFAULT_FAIL_FAST_THRESHOLD,
  type PlaybookScoredMatch,
} from "./playbook-executor";

test("scorePlaybookAgainst: reverse-substring intent match scores 0.55", () => {
  const score = scorePlaybookAgainst(
    { trigger_intents: ["melted_in_transit_full"], trigger_patterns: [] },
    "melted_in_transit",
    "",
  );
  assert.equal(score, 0.55);
});

test("scorePlaybookAgainst: substring intent match scores 0.85", () => {
  const score = scorePlaybookAgainst(
    { trigger_intents: ["melted"], trigger_patterns: [] },
    "melted_in_transit",
    "",
  );
  assert.equal(score, 0.85);
});

test("scorePlaybookAgainst: exact intent match scores 1.0", () => {
  const score = scorePlaybookAgainst(
    { trigger_intents: ["melted_in_transit"], trigger_patterns: [] },
    "melted_in_transit",
    "",
  );
  assert.equal(score, 1.0);
});

test("scorePlaybookAgainst: no triggers → 0", () => {
  const score = scorePlaybookAgainst(
    { trigger_intents: [], trigger_patterns: [] },
    "any_intent",
    "any message",
  );
  assert.equal(score, 0);
});

test("applyDeferThreshold: 0.55 < 0.65 → null (defer to Sonnet)", () => {
  const scored: PlaybookScoredMatch = { id: "pb1", name: "pb1", score: 0.55 };
  const gated = applyDeferThreshold(scored, DEFAULT_DEFER_THRESHOLD);
  assert.equal(gated, null);
});

test("applyDeferThreshold: 0.85 >= 0.65 → match survives", () => {
  const scored: PlaybookScoredMatch = { id: "pb1", name: "pb1", score: 0.85 };
  const gated = applyDeferThreshold(scored, DEFAULT_DEFER_THRESHOLD);
  assert.deepEqual(gated, scored);
});

test("applyDeferThreshold: null in → null out", () => {
  const gated = applyDeferThreshold(null, DEFAULT_DEFER_THRESHOLD);
  assert.equal(gated, null);
});

test("applyDeferThreshold: exact threshold match → passes (>=, not >)", () => {
  const scored: PlaybookScoredMatch = { id: "pb1", name: "pb1", score: 0.65 };
  const gated = applyDeferThreshold(scored, 0.65);
  assert.deepEqual(gated, scored);
});

test("DEFAULT_DEFER_THRESHOLD is 0.65 (per spec)", () => {
  assert.equal(DEFAULT_DEFER_THRESHOLD, 0.65);
});

test("DEFAULT_FAIL_FAST_THRESHOLD is 0.5 (per spec)", () => {
  assert.equal(DEFAULT_FAIL_FAST_THRESHOLD, 0.5);
});

test("assertPlaybookStepConfidence: confidence 0.4 escalates with reason='playbook_low_confidence'", async () => {
  const escalated: string[] = [];
  const result = await assertPlaybookStepConfidence(
    null as unknown as Parameters<typeof assertPlaybookStepConfidence>[0],
    "ticket-abc",
    0.4,
    DEFAULT_FAIL_FAST_THRESHOLD,
    { escalate: async (reason) => { escalated.push(reason); } },
  );
  assert.equal(result.stopped, true);
  assert.equal(result.reason, "playbook_low_confidence");
  assert.deepEqual(escalated, ["playbook_low_confidence"]);
});

test("assertPlaybookStepConfidence: confidence 0.6 does NOT escalate; stepping continues", async () => {
  const escalated: string[] = [];
  const result = await assertPlaybookStepConfidence(
    null as unknown as Parameters<typeof assertPlaybookStepConfidence>[0],
    "ticket-abc",
    0.6,
    DEFAULT_FAIL_FAST_THRESHOLD,
    { escalate: async (reason) => { escalated.push(reason); } },
  );
  assert.equal(result.stopped, false);
  assert.equal(escalated.length, 0);
});

test("assertPlaybookStepConfidence: null confidence does NOT escalate (unknown ≠ low)", async () => {
  const escalated: string[] = [];
  const result = await assertPlaybookStepConfidence(
    null as unknown as Parameters<typeof assertPlaybookStepConfidence>[0],
    "ticket-abc",
    null,
    DEFAULT_FAIL_FAST_THRESHOLD,
    { escalate: async (reason) => { escalated.push(reason); } },
  );
  assert.equal(result.stopped, false);
  assert.equal(escalated.length, 0);
});
