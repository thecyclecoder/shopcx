/**
 * Unit tests for the director-grader sweep's `considered/graded` accounting
 * (grading-starved-counter-ignores-inflight-targets spec, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:director-grader
 *   (= tsx --test src/lib/agents/director-grader.test.ts)
 *
 * The accounting is extracted as `tallySweepResult(state, result)` so the tests can drive each of
 * the three scenarios the spec names — in-flight target, terminal+success, terminal+LLM error —
 * without stubbing Supabase or the LLM. The bug being fixed: the old loop did `considered++`
 * before calling `gradeAutoApproval`, so an in-flight target (correctly skipped by the grader
 * with `reason='not_concluded'`) still ticked the counter — making the grading-starved monitor
 * page whenever the director had open auto-approvals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  INFLIGHT_SKIP_REASONS,
  isInflightSkip,
  tallySweepResult,
  type DirectorGradeResult,
} from "./director-grader";

test("INFLIGHT_SKIP_REASONS contains the three skip reasons the spec names — and nothing else", () => {
  assert.deepEqual(new Set(INFLIGHT_SKIP_REASONS), new Set(["not_concluded", "no_target", "decision_not_found"]));
});

test("isInflightSkip: every named skip reason is a skip", () => {
  for (const reason of INFLIGHT_SKIP_REASONS) {
    assert.equal(isInflightSkip({ ok: false, reason }), true, `${reason} should be an in-flight skip`);
  }
});

test("isInflightSkip: ok results are never skips (even when idempotent)", () => {
  assert.equal(isInflightSkip({ ok: true, grade: 8 }), false);
  assert.equal(isInflightSkip({ ok: true, idempotent_update: true, grade: 8 }), false);
});

test("isInflightSkip: an LLM/HTTP/parse error is NOT a skip — genuine starvation must still page", () => {
  assert.equal(isInflightSkip({ ok: false, reason: "parse_failed" }), false);
  assert.equal(isInflightSkip({ ok: false, reason: "grader_http_500" }), false);
  assert.equal(isInflightSkip({ ok: false, reason: "no_api_key" }), false);
});

test("in-flight target (gradeAutoApproval returns not_concluded) ⇒ considered=0, graded=0", () => {
  const state = { considered: 0, graded: 0 };
  tallySweepResult(state, { ok: false, reason: "not_concluded" });
  assert.deepEqual(state, { considered: 0, graded: 0 });
});

test("terminal target with successful grade ⇒ considered=1, graded=1", () => {
  const state = { considered: 0, graded: 0 };
  const result: DirectorGradeResult = { ok: true, grade_id: "g1", dimension: "auto-approval", grade: 9 };
  tallySweepResult(state, result);
  assert.deepEqual(state, { considered: 1, graded: 1 });
});

test("terminal target with LLM error ⇒ considered=1, graded=0 (genuine starvation still pages)", () => {
  const state = { considered: 0, graded: 0 };
  tallySweepResult(state, { ok: false, reason: "parse_failed" });
  assert.deepEqual(state, { considered: 1, graded: 0 });
});

test("idempotent re-grade (row already graded by agent) ⇒ considered=1, graded=0 (no double-count)", () => {
  const state = { considered: 0, graded: 0 };
  tallySweepResult(state, { ok: true, grade_id: "g1", dimension: "auto-approval", grade: 8, idempotent_update: true });
  assert.deepEqual(state, { considered: 1, graded: 0 });
});

test("mixed sweep — 2 in-flight + 1 terminal+ok + 1 terminal+error ⇒ considered=2, graded=1", () => {
  const state = { considered: 0, graded: 0 };
  tallySweepResult(state, { ok: false, reason: "not_concluded" });
  tallySweepResult(state, { ok: false, reason: "not_concluded" });
  tallySweepResult(state, { ok: true, grade_id: "g1", dimension: "auto-approval", grade: 7 });
  tallySweepResult(state, { ok: false, reason: "grader_http_500" });
  assert.deepEqual(state, { considered: 2, graded: 1 });
});

test("the original bug scenario — 2 in-flight + 0 terminal ⇒ considered=0 (was =2 pre-fix, which paged)", () => {
  // Pre-fix: considered=2, graded=0 → 2 consecutive sweeps → loop_alert opens (false-positive).
  // Post-fix: considered=0, graded=0 → starved flag stays clear; monitor only fires on REAL starvation.
  const state = { considered: 0, graded: 0 };
  tallySweepResult(state, { ok: false, reason: "not_concluded" });
  tallySweepResult(state, { ok: false, reason: "not_concluded" });
  assert.deepEqual(state, { considered: 0, graded: 0 });
});
