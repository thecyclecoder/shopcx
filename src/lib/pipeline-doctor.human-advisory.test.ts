/**
 * Regression test for the pipeline-doctor's greenness rule
 * (src/lib/pipeline-doctor.ts — `specTestGreen` + `detectInTestingNeedsHuman`).
 *
 * Human checks are ADVISORY per the SHARED [[isCleanMachinePassRun]] predicate — the SAME
 * gate the pre-merge promote and post-ship fold rails already use. Before this fix the
 * doctor re-decided greenness from the verdict string alone (`verdict === 'approved'`),
 * so a `needs_human` run that was a clean machine pass — three auto-passes, zero fails,
 * two advisory human checks — read as NOT-green and got classified `in-testing-needs-human`,
 * telling a human to go resolve checks that were never blocking. The 2026-08-31
 * playbook-drift-classifier-sees-the-pending-question run is the ground-truth case.
 *
 * The fix routes greenness through `isCleanMachinePassRun` (populated as
 * `SpecTestDiag.cleanMachinePass` at assembly time) so a needs_human run with ≥1 check
 * and 0 unresolved auto-`fail` counts as green — the same answer the promote/fold rails
 * give. The classifier still fires for the case it was really for: a needs_human verdict
 * that ALSO carries an unresolved machine fail.
 *
 * This test pins:
 *   (1) FAILING STATE — the 2026-08-31 shape: verdict `needs_human`, 5 checks (3 pass +
 *       2 needs_human), 0 fails → `specTestGreen` is TRUE and the classifier returns null;
 *   (2) CONVERSE — verdict `needs_human` with an UNRESOLVED `fail` check → the classifier
 *       still fires, so this can never become a blanket suppression that hides a real
 *       failure.
 *
 * Pure — no live DB. Constructs a SpecTestRun + a minimal SpecDiagnosis and invokes the
 * classifier directly, the same shape as `pipeline-doctor.built-not-stamped.test.ts`.
 *
 * Run: `npx tsx --test src/lib/pipeline-doctor.human-advisory.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  detectInTestingNeedsHuman,
  type SpecDiagnosis,
  type SpecTestDiag,
  type PhaseDiag,
} from "./pipeline-doctor";
import { isCleanMachinePassRun, checkKey, type SpecTestRun, type HumanCheckRow } from "./spec-test-runs";
import type { SpecStatus } from "./brain-roadmap";

// `specTestGreen` is module-private in pipeline-doctor.ts, but its only real consumer that changes
// shape with green vs not-green is `detectInTestingNeedsHuman` (which skips when it's true). So we
// assert the behaviour via that classifier PLUS the shared `isCleanMachinePassRun` directly — which
// is what the doctor now delegates to on the same run + resolutions.

function phase(overrides: Partial<PhaseDiag> = {}): PhaseDiag {
  return {
    index: 1,
    title: "P1",
    status: "in_progress",
    build_sha: "abc",
    merge_sha: null,
    pr: null,
    ...overrides,
  };
}

function specTest(overrides: Partial<SpecTestDiag>): SpecTestDiag {
  return {
    verdict: "needs_human",
    summary: { auto_pass: 3, auto_fail: 0, needs_human: 2, inconclusive: 0 },
    branch: "claude/build-playbook-drift-classifier-sees-the-pending-question",
    hasOpenRegression: false,
    ageMinutes: 30,
    cleanMachinePass: true,
    ...overrides,
  };
}

function diag(overrides: Partial<SpecDiagnosis> = {}): SpecDiagnosis {
  const base: SpecDiagnosis = {
    slug: "playbook-drift-classifier-sees-the-pending-question",
    title: "playbook-drift-classifier-sees-the-pending-question",
    owner: null,
    parent: null,
    goalSlug: null,
    derivedStatus: "in_testing" as SpecStatus | "folded",
    rawStatus: null,
    critical: false,
    autoBuild: true,
    valeReviewPassed: true,
    blockedByOpen: [],
    onGoalBranch: false,
    phases: [phase()],
    jobs: [],
    specTest: specTest({}),
    security: null,
    lifecycle: { stage: "fold", status: "pending" } as SpecDiagnosis["lifecycle"],
    foldRefusal: null,
    detectors: [],
    stuck: { isStuck: false, severity: "none", detector: null, reason: "", sinceMinutes: null, suggestedAction: null },
  };
  return { ...base, ...overrides };
}

function runOf(overrides: Partial<SpecTestRun>): SpecTestRun {
  const base: SpecTestRun = {
    id: "run-1",
    workspace_id: "ws-1",
    spec_slug: "playbook-drift-classifier-sees-the-pending-question",
    agent_job_id: null,
    agent_verdict: "needs_human",
    summary: { auto_pass: 0, auto_fail: 0, needs_human: 0, inconclusive: 0 },
    checks: [],
    transcript: null,
    error: null,
    spec_branch: null,
    preview_url: null,
    run_at: "2026-08-31T00:00:00Z",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
  };
  return { ...base, ...overrides };
}

// ── (1) FAILING STATE — the 2026-08-31 measured run ─────────────────────

test("(FAILING STATE) needs_human + 3 pass + 0 fail + 2 needs_human is a clean machine pass — shared predicate agrees", () => {
  // The exact shape of the 2026-08-31 playbook-drift-classifier-sees-the-pending-question run:
  // three machine checks passing, zero failures, two advisory human checks. The advisory
  // checks were themselves only a harness gap (no `gh` binary), NOT a real failure.
  const run = runOf({
    agent_verdict: "needs_human",
    summary: { auto_pass: 3, auto_fail: 0, needs_human: 2, inconclusive: 0 },
    checks: [
      { text: "tsc clean", verdict: "pass" },
      { text: "the doctor imports the shared clean-pass predicate", verdict: "pass" },
      { text: "SpecTestDiag exposes cleanMachinePass", verdict: "pass" },
      { text: "CI is green on the merge sha", verdict: "needs_human" },
      { text: "the change is visible on the deployed doctor", verdict: "needs_human" },
    ],
  });
  const resolutions = new Map<string, HumanCheckRow>();
  assert.equal(
    isCleanMachinePassRun(run, resolutions, "playbook-drift-classifier-sees-the-pending-question"),
    true,
    "the shared predicate must return true — this is the pre-merge/fold rails' answer",
  );
});

test("(FAILING STATE) doctor: an advisory-only needs_human run is NOT reported stuck (classifier returns null)", () => {
  // This is the whole point: before the fix, verdict !== 'approved' meant not-green, so this
  // exact shape got classified `in-testing-needs-human` and the founder was told to go
  // resolve checks that were never blocking. The fix routes greenness through
  // `isCleanMachinePassRun`, so an advisory-only run is a clean pass — nothing to report.
  const d = diag({
    derivedStatus: "in_testing",
    specTest: specTest({
      verdict: "needs_human",
      summary: { auto_pass: 3, auto_fail: 0, needs_human: 2, inconclusive: 0 },
      cleanMachinePass: true,
    }),
  });
  const r = detectInTestingNeedsHuman(d, {} as never);
  assert.equal(r, null, "an advisory-only clean-machine-pass run must NOT classify as needs-human-stuck");
});

// ── (2) CONVERSE — a real machine failure hiding inside needs_human still fires ──

test("(CONVERSE) needs_human WITH an unresolved auto-fail: shared predicate rejects it", () => {
  // A `needs_human` verdict can still carry an unresolved auto-`fail` — the run is NOT a
  // clean machine pass. The predicate must reject it so the classifier can still fire.
  const run = runOf({
    agent_verdict: "needs_human",
    summary: { auto_pass: 2, auto_fail: 1, needs_human: 1, inconclusive: 0 },
    checks: [
      { text: "tsc clean", verdict: "pass" },
      { text: "the doctor imports the shared clean-pass predicate", verdict: "pass" },
      { text: "specTestGreen returns true for the 08-31 shape", verdict: "fail" },
      { text: "CI is green on the merge sha", verdict: "needs_human" },
    ],
  });
  const resolutions = new Map<string, HumanCheckRow>();
  assert.equal(
    isCleanMachinePassRun(run, resolutions, "playbook-drift-classifier-sees-the-pending-question"),
    false,
    "unresolved auto-fail must reject the clean-pass predicate",
  );
});

test("(CONVERSE) doctor: needs_human WITH an unresolved auto-fail still classifies as stuck", () => {
  // The classifier must keep firing for the case it was really for: a needs-human verdict
  // that ALSO carries an unresolved machine fail. This prevents the fix from becoming a
  // blanket suppression that hides a real failure.
  const d = diag({
    derivedStatus: "in_testing",
    specTest: specTest({
      verdict: "needs_human",
      summary: { auto_pass: 2, auto_fail: 1, needs_human: 1, inconclusive: 0 },
      cleanMachinePass: false,
    }),
  });
  const r = detectInTestingNeedsHuman(d, {} as never);
  assert.notEqual(r, null, "an unresolved auto-fail hiding inside needs_human must still be surfaced");
  assert.equal(r!.name, "in-testing-needs-human");
  // The reason string must call out the AUTO-FAIL as the blocker, not the advisory human checks —
  // the spec's whole point is that human checks never make a spec stuck.
  assert.match(r!.reason, /auto-fail/i, "reason must name the machine fail as the blocker");
  // And the suggestedAction must stop telling a human that resolving the advisory human checks
  // will clear the gate — the blocker here is the machine failure.
  assert.doesNotMatch(
    r!.suggestedAction,
    /resolve the needs-human spec-test check/i,
    "suggestedAction must NOT tell a human to resolve advisory checks when the blocker is a machine fail",
  );
});

// ── (3) A resolved auto-fail is not a blocker (verified/dismissed clears it) ──

test("(CONVERSE) needs_human with an auto-fail that has been VERIFIED is a clean pass again", () => {
  const run = runOf({
    agent_verdict: "needs_human",
    summary: { auto_pass: 2, auto_fail: 1, needs_human: 1, inconclusive: 0 },
    checks: [
      { text: "tsc clean", verdict: "pass" },
      { text: "the doctor imports the shared clean-pass predicate", verdict: "pass" },
      { text: "specTestGreen returns true for the 08-31 shape", verdict: "fail" },
      { text: "CI is green on the merge sha", verdict: "needs_human" },
    ],
  });
  const slug = "playbook-drift-classifier-sees-the-pending-question";
  const resolutions = new Map<string, HumanCheckRow>();
  resolutions.set(`${slug}:${checkKey("specTestGreen returns true for the 08-31 shape")}`, {
    spec_slug: slug,
    check_key: checkKey("specTestGreen returns true for the 08-31 shape"),
    check_text: "specTestGreen returns true for the 08-31 shape",
    resolution: "verified",
    note: null,
    resolved_at: "2026-08-31T00:00:00Z",
  });
  assert.equal(
    isCleanMachinePassRun(run, resolutions, slug),
    true,
    "a verified/dismissed resolution on the failing check clears it — the run is a clean pass",
  );
});

// ── (4) A different derived status (not in_testing) — classifier never fires anyway ──

test("NEGATIVE: derivedStatus !== 'in_testing' → classifier returns null regardless of cleanMachinePass", () => {
  for (const s of ["planned", "in_progress", "shipped", "folded"] as (SpecStatus | "folded")[]) {
    const d = diag({
      derivedStatus: s,
      specTest: specTest({ cleanMachinePass: false, verdict: "needs_human" }),
    });
    assert.equal(
      detectInTestingNeedsHuman(d, {} as never),
      null,
      `derivedStatus=${s} must never classify — the guard is in_testing-only`,
    );
  }
});
