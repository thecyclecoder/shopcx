/**
 * Regression test for the pipeline-doctor's `shipped-not-folded` classifier
 * (src/lib/pipeline-doctor.ts — `detectShippedNotFolded`).
 *
 * ⭐ [[../../docs/brain/specs/a-shipped-spec-that-cannot-fold-is-stuck]] Phase 1.
 *
 * The pipeline doctor decides whether a spec is stuck by looking at builds, spec-tests, security
 * and merges — and stops there. Folding is outside its definition entirely, so a spec whose
 * phases have all shipped but which the fold gate keeps refusing was reported as perfectly
 * healthy. Over 2026-08-31 and 2026-09-02 that happened four separate times: specs sat
 * shipped-but-unfolded for days while the doctor reported zero stuck, and on every occasion the
 * founder noticed before the system did.
 *
 * The fix adds `detectShippedNotFolded` — the classifier fires when ALL hold:
 *   1. derivedStatus === "shipped" (the same rail every other classifier uses),
 *   2. rawStatus is neither "deferred" nor "folded" (a parked / already-folded spec is not stuck),
 *   3. no LIVE build/spec-test/fold/goal-fold job (mirror the fold gate's own in-flight defer so
 *      the board never alarms on healthy in-flight work),
 *   4. `foldRefusal` is populated (the fold gate produced a specific refusal reason),
 *   5. the most-recent job activity is at least `SHIPPED_NOT_FOLDED_GRACE_MIN` (12 hours) old.
 *
 * Severity `medium`; `suggestedAction` MUST be the fold gate's own refusal, not a generic
 * "investigate".
 *
 * This test pins ALL FIVE cases from the spec, using the four real 2026 shapes:
 *   (POSITIVE) shipped + unfolded + past the window + no live job → STUCK, and the reason
 *              contains the gate's refusal text;
 *   (NEGATIVE) shipped + unfolded but INSIDE the grace window → not stuck;
 *   (NEGATIVE) shipped + unfolded with a live BUILD job → not stuck;
 *   (NEGATIVE) `deferred` → not stuck;
 *   (NEGATIVE) `folded` → not stuck.
 *
 * The four negative cases are the load-bearing ones — a detector that cries wolf on healthy
 * in-flight work gets ignored, which would recreate the very blindness this classifier is
 * meant to close.
 *
 * Pure — no live DB. Constructs a SpecDiagnosis directly and invokes the classifier, the same
 * shape as `pipeline-doctor.built-not-stamped.test.ts` and `pipeline-doctor.human-advisory.test.ts`.
 *
 * Run: `npx tsx --test src/lib/pipeline-doctor.shipped-not-folded.test.ts`
 * or `npm run test:doctor-shipped-not-folded`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  detectShippedNotFolded,
  type SpecDiagnosis,
  type JobDiag,
  type PhaseDiag,
} from "./pipeline-doctor";
import type { SpecStatus } from "./brain-roadmap";

// One representative refusal — the 2026-08-17 phase-accumulation shape (Rail 4a). The classifier
// must surface this string verbatim in both `reason` and `suggestedAction` — that is the whole
// point of the spec (the board says WHY, not merely that something is).
const REFUSAL_PHASE_MISMATCH =
  "phase merge_sha does NOT contain phase build_sha for: pos 2 (build=(none) merge=9ea6351de)";

const SHIPPED_NOT_FOLDED_GRACE_MIN = 12 * 60;

function phase(overrides: Partial<PhaseDiag> = {}): PhaseDiag {
  return {
    index: 1,
    title: "P1",
    status: "shipped",
    build_sha: "abc123",
    merge_sha: "def456",
    pr: 1234,
    ...overrides,
  };
}

function job(overrides: Partial<JobDiag> = {}): JobDiag {
  return {
    kind: "build",
    status: "merged",
    branch: "claude/build-example",
    prNumber: 1234,
    // Default: WELL past the grace window (24h ≥ 12h floor), so a spec built from `job()` is
    // ELIGIBLE for the classifier to fire. Individual tests override this to test the grace floor.
    ageMinutes: 24 * 60,
    heartbeatAgeMinutes: null,
    needsAttentionClass: null,
    error: null,
    logTail: null,
    pendingPrompts: [],
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function diag(overrides: Partial<SpecDiagnosis> = {}): SpecDiagnosis {
  const base: SpecDiagnosis = {
    slug: "example-shipped-not-folded",
    title: "Example shipped-not-folded",
    owner: "platform",
    parent: null,
    goalSlug: null,
    derivedStatus: "shipped" as SpecStatus | "folded",
    rawStatus: null,
    critical: false,
    autoBuild: true,
    valeReviewPassed: true,
    blockedByOpen: [],
    onGoalBranch: false,
    phases: [phase()],
    jobs: [job()],
    specTest: null,
    security: null,
    lifecycle: { stage: "fold", status: "pending" } as SpecDiagnosis["lifecycle"],
    foldRefusal: REFUSAL_PHASE_MISMATCH,
    detectors: [],
    stuck: { isStuck: false, severity: "none", detector: null, reason: "", sinceMinutes: null, suggestedAction: null },
  };
  return { ...base, ...overrides };
}

// ── (POSITIVE) shipped + unfolded + past window + no live job → STUCK ──

test("(POSITIVE) shipped + unfolded + past the grace window + no live job → classifier fires and reports the gate's refusal", () => {
  // The exact 2026-08-17 shape: shipped derived rollup, un-parked, no live jobs, and the fold gate
  // computed a specific refusal — the phase merge_sha doesn't contain the phase build_sha. Before
  // this classifier the board said "zero stuck" and the founder noticed after DAYS.
  const d = diag({
    derivedStatus: "shipped",
    rawStatus: null,
    jobs: [job({ ageMinutes: 48 * 60 })], // 2 days shipped-and-unfolded
    foldRefusal: REFUSAL_PHASE_MISMATCH,
  });
  const r = detectShippedNotFolded(d, {} as never);
  assert.notEqual(r, null, "a shipped-and-unfolded spec past the grace window MUST be stuck");
  assert.equal(r!.name, "shipped-not-folded");
  assert.equal(r!.severity, "medium", "bookkeeping debt, not a broken build — medium severity");
  // The reason must CONTAIN the fold gate's refusal text — the whole point of the spec.
  assert.match(
    r!.reason,
    /phase merge_sha does NOT contain phase build_sha/,
    "reason must carry the gate's OWN refusal, not a generic message",
  );
  // The suggestedAction must BE the refusal (verbatim) — the board's action IS the refusal, not
  // "investigate". The 2026-08-31 / 2026-09-02 incidents happened because a generic "investigate"
  // is exactly as useful as no signal at all.
  assert.equal(
    r!.suggestedAction,
    REFUSAL_PHASE_MISMATCH,
    "suggestedAction must be the fold gate's OWN refusal verbatim",
  );
  assert.equal(r!.sinceMinutes, 48 * 60, "sinceMinutes tracks the newest job's age");
});

// ── (NEGATIVE) inside the grace window → NOT stuck ──

test("(NEGATIVE) shipped + unfolded but INSIDE the grace window → classifier returns null (fold cron may not have swept yet)", () => {
  // A spec that just shipped is NOT stuck — the fold gate runs reactively on every spec-test
  // completion + daily sweep, so a spec that only just landed hasn't had its fold cycle yet. The
  // detector MUST stay quiet inside the grace window or every fresh ship would cry wolf.
  const d = diag({
    derivedStatus: "shipped",
    rawStatus: null,
    // 1 hour old — WELL inside the 12-hour grace window.
    jobs: [job({ ageMinutes: 60 })],
    foldRefusal: REFUSAL_PHASE_MISMATCH,
  });
  const r = detectShippedNotFolded(d, {} as never);
  assert.equal(
    r,
    null,
    "a spec shipped 1h ago is NOT stuck — the fold cron may not have swept yet, mirror its cadence",
  );
  // Sanity: right at the boundary is still quiet (< the floor, not <=).
  const boundary = diag({
    derivedStatus: "shipped",
    jobs: [job({ ageMinutes: SHIPPED_NOT_FOLDED_GRACE_MIN - 1 })],
    foldRefusal: REFUSAL_PHASE_MISMATCH,
  });
  assert.equal(detectShippedNotFolded(boundary, {} as never), null, "under the grace floor stays quiet");
});

// ── (NEGATIVE) live build job → NOT stuck (mirror the fold gate's own in-flight defer) ──

test("(NEGATIVE) shipped + unfolded but a LIVE build job is running → classifier returns null (fold gate itself defers on a live job)", () => {
  // getAutoFoldEligibleSlugs rejects a live-slug candidate — auto-folding it would orphan the
  // running build (its spec page 404s the moment the fold merges). The doctor MUST mirror that or
  // the board would alarm on healthy in-flight work — the exact cry-wolf case that would recreate
  // the visibility gap this classifier is closing.
  const d = diag({
    derivedStatus: "shipped",
    rawStatus: null,
    jobs: [
      job({ kind: "build", status: "building", ageMinutes: 48 * 60 }), // live build, well past window
    ],
    foldRefusal: REFUSAL_PHASE_MISMATCH,
  });
  const r = detectShippedNotFolded(d, {} as never);
  assert.equal(
    r,
    null,
    "a live build/spec-test/fold job means the pipeline is still working — not stuck",
  );
  // Also true for other live lifecycle kinds.
  for (const kind of ["spec-test", "fold", "goal-fold"] as const) {
    const withLive = diag({
      jobs: [job({ kind, status: "claimed", ageMinutes: 48 * 60 })],
    });
    assert.equal(
      detectShippedNotFolded(withLive, {} as never),
      null,
      `a live ${kind} job must silence the classifier`,
    );
  }
});

// ── (NEGATIVE) deferred → NOT stuck ──

test("(NEGATIVE) rawStatus='deferred' → classifier returns null (a parked spec is not stuck)", () => {
  // A `deferred` spec is parked by CEO choice. The `deferred-parked` classifier owns that state;
  // shipped-not-folded must never fire on it, even if all other rails hold. Belt + suspenders: a
  // shipped rollup with a deferred stored override shouldn't reach here, but the guard is explicit.
  const d = diag({
    derivedStatus: "shipped",
    rawStatus: "deferred",
    jobs: [job({ ageMinutes: 48 * 60 })],
    foldRefusal: REFUSAL_PHASE_MISMATCH,
  });
  const r = detectShippedNotFolded(d, {} as never);
  assert.equal(r, null, "a deferred spec is CEO-parked and never stuck");
});

// ── (NEGATIVE) folded → NOT stuck ──

test("(NEGATIVE) rawStatus='folded' → classifier returns null (the spec already folded)", () => {
  // A folded spec has nothing to alarm about. The derived rollup would normally show "folded", but
  // the stored override is checked as a defensive belt when derived is still "shipped" mid-flip.
  const d = diag({
    derivedStatus: "shipped",
    rawStatus: "folded",
    jobs: [job({ ageMinutes: 48 * 60 })],
    foldRefusal: REFUSAL_PHASE_MISMATCH,
  });
  const r = detectShippedNotFolded(d, {} as never);
  assert.equal(r, null, "a spec already stored-folded is not stuck");

  // And the fully-folded derived case is silent by construction (derived !== 'shipped').
  const derivedFolded = diag({
    derivedStatus: "folded" as SpecStatus | "folded",
    rawStatus: "folded",
    jobs: [job({ ageMinutes: 48 * 60 })],
    foldRefusal: REFUSAL_PHASE_MISMATCH,
  });
  assert.equal(detectShippedNotFolded(derivedFolded, {} as never), null, "derivedStatus='folded' is silent");
});

// ── (NEGATIVE) no fold refusal → NOT stuck (the gate said eligible; the fold is imminent) ──

test("(NEGATIVE) foldRefusal === null → classifier returns null (the gate said ELIGIBLE; the fold is imminent)", () => {
  // When the fold gate returned this slug in its `eligible` list, `getFoldRefusalsBySlug` has no
  // entry for it and `foldRefusal` is null. A fold job will land within seconds — not stuck.
  const d = diag({
    derivedStatus: "shipped",
    rawStatus: null,
    jobs: [job({ ageMinutes: 48 * 60 })],
    foldRefusal: null,
  });
  const r = detectShippedNotFolded(d, {} as never);
  assert.equal(r, null, "no refusal means the gate said eligible — the fold is imminent, not stuck");
});
