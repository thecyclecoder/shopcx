/**
 * goal-main-promote-gates-on-artifact-not-stale-per-member-rechecks Phase 2 — the pure classifier under
 * the M5 CI gate. Pins the NAMED failing state from the spec's Why (a stale per-member accumulation
 * grep let a false-negative HOLD an artifact-clean goal) by asserting the artifact-side classifier
 * fails CLOSED on every unknown state — unread ci, empty check-run list, in-flight run, red
 * conclusion — and only turns green on a positively-verified all-complete-all-success set.
 *
 * The pure predicate `classifyCheckRunsForCiGreen` is the seam this test exercises directly — the async
 * wrapper `goalBranchCiGreen` composes `branchHeadSha` + `gh()` + this classifier, so covering the
 * classifier covers the verdict shape end-to-end. Pure — no I/O. Run:
 *   npx tsx --test src/lib/goal-branch-ci-green.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { classifyCheckRunsForCiGreen, type CheckRunLite } from "./github-pr-resolve";

test("null (fetch error) → not green — fail-closed on unread ci", () => {
  const v = classifyCheckRunsForCiGreen(null);
  assert.equal(v.green, false);
  assert.match(v.reason, /read failed/);
});

test("empty check-run list → not green — no positive verification, hold the promote", () => {
  const v = classifyCheckRunsForCiGreen([]);
  assert.equal(v.green, false);
  assert.match(v.reason, /no check-runs/);
});

test("any in-flight run (status != completed) → not green — never merge on an unknown artifact state", () => {
  const runs: CheckRunLite[] = [
    { name: "Vercel", status: "completed", conclusion: "success" },
    { name: "spec-test", status: "in_progress", conclusion: null },
  ];
  const v = classifyCheckRunsForCiGreen(runs);
  assert.equal(v.green, false);
  assert.match(v.reason, /spec-test/);
  assert.match(v.reason, /in_progress/);
});

test("any red conclusion (failure) → not green", () => {
  const runs: CheckRunLite[] = [
    { name: "Vercel", status: "completed", conclusion: "success" },
    { name: "spec-test", status: "completed", conclusion: "failure" },
  ];
  const v = classifyCheckRunsForCiGreen(runs);
  assert.equal(v.green, false);
  assert.match(v.reason, /spec-test/);
  assert.match(v.reason, /failure/);
});

test("cancelled / timed_out / action_required all count as not green", () => {
  for (const red of ["cancelled", "timed_out", "action_required", "stale"]) {
    const v = classifyCheckRunsForCiGreen([
      { name: "check-x", status: "completed", conclusion: red },
    ]);
    assert.equal(v.green, false, `${red} must not be green`);
    assert.match(v.reason, new RegExp(red));
  }
});

test("all completed + all green conclusions → green (positive verification)", () => {
  const runs: CheckRunLite[] = [
    { name: "Vercel", status: "completed", conclusion: "success" },
    { name: "spec-test", status: "completed", conclusion: "success" },
    { name: "advisory", status: "completed", conclusion: "neutral" },
    { name: "path-filtered", status: "completed", conclusion: "skipped" },
  ];
  const v = classifyCheckRunsForCiGreen(runs);
  assert.equal(v.green, true);
  assert.match(v.reason, /4 check-run\(s\) green/);
});
