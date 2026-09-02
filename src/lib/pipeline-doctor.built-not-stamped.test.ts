/**
 * Regression test for `detectBuiltNotStamped` (src/lib/pipeline-doctor.ts).
 *
 * The classifier's own reason string names the missed-stamp case: "the build ran yet
 * stampPhaseBuilt never advanced any phase". Spec status is a rollup over DERIVED phase
 * status, and `derivePhaseStatus` returns `in_progress` only when `build_sha` is non-null,
 * so a spec with no phase stamped derives `planned`, not `in_progress`. Before this fix
 * the guard `derivedStatus === "in_progress"` was mutually exclusive with the case being
 * classified — the alarm could never fire on the exact case it names, and the card-removal
 * spec sat seventeen hours with an unfixed credential leak because of it.
 *
 * The fix admits a shared status set instead of a single status. This test pins:
 *   (1) FAILING STATE — derivedStatus='planned' + latest build 'completed' + no phase
 *       carries a build_sha/pr/merge_sha → the built-not-stamped classifier fires
 *       (previously unreachable);
 *   (2) NEGATIVE — no completed build job → does NOT classify (specific to a real miss);
 *   (3) NEGATIVE — a stamped phase → does NOT classify (spec advanced normally).
 *
 * Pure — no live DB. Constructs a minimal SpecDiagnosis and invokes the classifier
 * directly, the same shape `action-executor.vaulted-pm-guard.test.ts` uses for
 * `pickChargeableVaultedPm`.
 *
 * Run: `npx tsx --test src/lib/pipeline-doctor.built-not-stamped.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_NOT_STAMPED_STATUSES,
  detectBuiltNotStamped,
  type JobDiag,
  type PhaseDiag,
  type SpecDiagnosis,
} from "./pipeline-doctor";
import type { SpecStatus } from "./brain-roadmap";

function phase(overrides: Partial<PhaseDiag> = {}): PhaseDiag {
  return {
    index: 1,
    title: "P1 — implement the fix",
    status: "planned",
    build_sha: null,
    merge_sha: null,
    pr: null,
    ...overrides,
  };
}

function buildJob(overrides: Partial<JobDiag> = {}): JobDiag {
  return {
    kind: "build",
    status: "completed",
    branch: "claude/build-x",
    prNumber: 1234,
    ageMinutes: 60,
    heartbeatAgeMinutes: null,
    needsAttentionClass: null,
    error: null,
    logTail: null,
    pendingPrompts: [],
    updatedAt: "2026-08-17T00:00:00Z",
    ...overrides,
  };
}

function diag(overrides: Partial<SpecDiagnosis> = {}): SpecDiagnosis {
  const base: SpecDiagnosis = {
    slug: "x",
    title: "X",
    owner: null,
    parent: null,
    goalSlug: null,
    derivedStatus: "planned" as SpecStatus | "folded",
    rawStatus: null,
    critical: false,
    autoBuild: true,
    valeReviewPassed: true,
    blockedByOpen: [],
    onGoalBranch: false,
    phases: [phase()],
    jobs: [buildJob()],
    specTest: null,
    security: null,
    lifecycle: { stage: "build", status: "pending" } as SpecDiagnosis["lifecycle"],
    foldRefusal: null,
    detectors: [],
    stuck: { isStuck: false, severity: "none", detector: null, reason: "", sinceMinutes: null, suggestedAction: null },
  };
  return { ...base, ...overrides };
}

// ── The shared status set is what makes the missed-stamp case reachable ──

test("BUILT_NOT_STAMPED_STATUSES admits both planned AND in_progress (the fix)", () => {
  assert.equal(BUILT_NOT_STAMPED_STATUSES.has("planned"), true);
  assert.equal(BUILT_NOT_STAMPED_STATUSES.has("in_progress"), true);
  // The guard must NOT be widened to catch other states — the specificity of the signal
  // depends on it. `in_testing`/`shipped` mean the pipeline advanced somewhere.
  assert.equal(BUILT_NOT_STAMPED_STATUSES.has("in_testing"), false);
  assert.equal(BUILT_NOT_STAMPED_STATUSES.has("shipped"), false);
});

// ── (1) FAILING STATE — the previously unreachable case ─────────────────

test("(FAILING STATE) derivedStatus='planned' + completed build + no build_sha anywhere → classifies as built-not-stamped", () => {
  // The card-removal spec's exact shape: the build ran to completion on a phase-scoped
  // branch, but stampPhaseBuilt never advanced any phase, so the spec derives 'planned'.
  // Before the fix this returned null at the first guard.
  const d = diag({
    slug: "card-removal-fix",
    derivedStatus: "planned",
    phases: [phase({ index: 1, title: "P1 — implement the fix" })],
    jobs: [buildJob({ status: "completed", branch: "claude/build-card-removal-fix" })],
  });
  const r = detectBuiltNotStamped(d, {} as never);
  assert.notEqual(r, null);
  assert.equal(r!.name, "built-not-stamped");
  assert.equal(r!.severity, "high");
  assert.match(r!.reason, /NO phase carries a build_sha/);
});

test("(FAILING STATE) derivedStatus='in_progress' + completed build + no build_sha → still classifies (the previously-covered case still works)", () => {
  const d = diag({
    derivedStatus: "in_progress",
    phases: [phase({ status: "in_progress" })],
    jobs: [buildJob()],
  });
  const r = detectBuiltNotStamped(d, {} as never);
  assert.notEqual(r, null);
  assert.equal(r!.name, "built-not-stamped");
});

test("(FAILING STATE) derivedStatus='planned' + merged build + no build_sha → classifies", () => {
  const d = diag({
    derivedStatus: "planned",
    jobs: [buildJob({ status: "merged" })],
  });
  const r = detectBuiltNotStamped(d, {} as never);
  assert.notEqual(r, null);
  assert.equal(r!.name, "built-not-stamped");
});

// ── (2) NEGATIVE — no completed build job ───────────────────────────────

test("NEGATIVE: no build job at all → does NOT classify (a spec that never built is not a missed stamp)", () => {
  const d = diag({ derivedStatus: "planned", jobs: [] });
  assert.equal(detectBuiltNotStamped(d, {} as never), null);
});

test("NEGATIVE: build job status is 'building' / 'claimed' / 'needs_approval' → does NOT classify", () => {
  for (const status of ["building", "claimed", "needs_approval", "needs_input", "failed"] as const) {
    const d = diag({ derivedStatus: "planned", jobs: [buildJob({ status })] });
    assert.equal(detectBuiltNotStamped(d, {} as never), null, `status=${status} should not classify`);
  }
});

// ── (3) NEGATIVE — a stamped phase ──────────────────────────────────────

test("NEGATIVE: a phase carries a build_sha → does NOT classify (the build DID advance)", () => {
  const d = diag({
    derivedStatus: "in_progress",
    phases: [phase({ status: "in_progress", build_sha: "abc123def" })],
    jobs: [buildJob()],
  });
  assert.equal(detectBuiltNotStamped(d, {} as never), null);
});

test("NEGATIVE: a phase is shipped (carries merge_sha) → does NOT classify", () => {
  const d = diag({
    derivedStatus: "in_progress",
    phases: [phase({ status: "shipped", build_sha: "abc", merge_sha: "def", pr: 42 })],
    jobs: [buildJob({ status: "merged" })],
  });
  assert.equal(detectBuiltNotStamped(d, {} as never), null);
});

// ── Status guard specificity — advanced states are still ignored ────────

test("NEGATIVE: derivedStatus='in_testing' / 'shipped' / 'folded' / 'deferred' → does NOT classify (outside the admitted set)", () => {
  for (const s of ["in_testing", "shipped", "folded", "deferred", "in_review", "rejected"] as (SpecStatus | "folded")[]) {
    const d = diag({ derivedStatus: s, jobs: [buildJob()] });
    assert.equal(detectBuiltNotStamped(d, {} as never), null, `derivedStatus=${s} should not classify`);
  }
});
