/**
 * Unit tests for [[build-that-never-finishes-is-visible-to-mario]] Phase 3.
 *
 * The bug the spec calls out: `mario_thresholds` originally carried a single row
 * (`build_done → phase_shipped`), so `evaluateStalledSpecs` could only surface a
 * transition whose last timecard event was `build_done`. A spec whose timecard
 * stops at `build_started` (build died mid-flight but never marked failed, or
 * the worker crashed before `emitTimecardEvent('build_done')` ran) matched NO
 * threshold's `from_event` and was silently invisible — no `mario` job enqueued,
 * no supervisor asked. Measured 2026-08-03: 432 specs sit in that shape; 3 have
 * been silent for ~40 h, 80× over the 30-min SLA the finish-side pair carries.
 *
 * The fix (Phase 1) adds the `build_started → build_done` threshold row. This
 * test pins the surfacing decision the row unlocks via the pure predicate
 * [[matchesMarioThresholdForOverdueTransition]]:
 *
 *   - WITH only the old threshold, a `build_started` spec past SLA is NOT
 *     surfaced (the exact historical blind spot).
 *   - WITH the new threshold row, the SAME spec IS surfaced under
 *     `from_event='build_started', to_event='build_done'`.
 *   - The gap-vs-SLA boundary is a strict `>`, matching `listStalledCandidates`.
 *   - The original `build_done → phase_shipped` surfacing is unchanged.
 *
 * Pure predicate — no I/O, no DB, no Supabase stub. Same shape as the sibling
 * `shouldSurface*` tests. Run:
 *   npx tsx --test src/lib/mario.build-started-no-build-done.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { matchesMarioThresholdForOverdueTransition } from "./mario";

// Mirrors the new mario_thresholds row seeded by
// supabase/migrations/20261212120000_mario_threshold_build_started_build_done.sql.
const BUILD_STARTED_TO_BUILD_DONE_SLA_MS = 90 * 60 * 1000; // 90 min
const OVER_SLA_MS = BUILD_STARTED_TO_BUILD_DONE_SLA_MS + 1;
const UNDER_SLA_MS = BUILD_STARTED_TO_BUILD_DONE_SLA_MS - 1;

// The original finish-side pair — the ONLY threshold row before this spec.
const BUILD_DONE_TO_PHASE_SHIPPED_SLA_MS = 30 * 60 * 1000; // 30 min

test("Historical blind spot — build_started spec past SLA does NOT match the finish-side threshold (from_event='build_done')", () => {
  // Before Phase 1, the ONLY threshold's from_event was 'build_done'. A spec whose
  // last timecard event is 'build_started' has NO threshold whose from_event matches
  // → the evaluator's `continue` fires → the candidate is silently dropped. This is
  // exactly the class the 3 named specs (40 h silent, 80× SLA) sat in.
  const surfaced = matchesMarioThresholdForOverdueTransition({
    lastEventKind: "build_started",
    fromEvent: "build_done",
    gapMs: 40 * 60 * 60 * 1000, // 40 hours — 80× over the finish-side SLA
    slaMs: BUILD_DONE_TO_PHASE_SHIPPED_SLA_MS,
  });
  assert.equal(surfaced, false);
});

test("Phase 1 fix — build_started spec past SLA IS surfaced under the new build_started→build_done threshold", () => {
  const surfaced = matchesMarioThresholdForOverdueTransition({
    lastEventKind: "build_started",
    fromEvent: "build_started",
    gapMs: OVER_SLA_MS,
    slaMs: BUILD_STARTED_TO_BUILD_DONE_SLA_MS,
  });
  assert.equal(surfaced, true);
});

test("Phase 1 fix — the 3 currently-stalled specs (~40 h silent) are surfaced under the new threshold", () => {
  // Grounding the abstract predicate in the exact evidence the spec cites: 40 h is
  // 80× over the new 90-min SLA (and would still be 80× over ANY plausibly tighter
  // SLA), so the surfacing decision is not sensitive to the SLA-choice knob.
  const surfaced = matchesMarioThresholdForOverdueTransition({
    lastEventKind: "build_started",
    fromEvent: "build_started",
    gapMs: 40 * 60 * 60 * 1000,
    slaMs: BUILD_STARTED_TO_BUILD_DONE_SLA_MS,
  });
  assert.equal(surfaced, true);
});

test("Grace boundary — gap EQUAL to SLA is NOT surfaced (strict >, mirrors listStalledCandidates)", () => {
  // `listStalledCandidates` filters `gap_ms > older_than_ms`, so a candidate whose
  // gap equals the SLA exactly is dropped upstream. The predicate re-asserts the
  // same strict comparison so a future refactor that pushes both checks into the
  // predicate can never silently relax the boundary to `>=`.
  const surfaced = matchesMarioThresholdForOverdueTransition({
    lastEventKind: "build_started",
    fromEvent: "build_started",
    gapMs: BUILD_STARTED_TO_BUILD_DONE_SLA_MS,
    slaMs: BUILD_STARTED_TO_BUILD_DONE_SLA_MS,
  });
  assert.equal(surfaced, false);
});

test("Grace window — build_started within SLA is NOT surfaced (normal long build is safe)", () => {
  // The SLA was picked (90 min = BUILD_HARD_CAP_MS 60 min + a 30-min recovery
  // grace) so a normal long build never trips it. Pin that a within-SLA gap is
  // NOT surfaced so a tighter SLA cannot be quietly adopted without a matching
  // test failure.
  const surfaced = matchesMarioThresholdForOverdueTransition({
    lastEventKind: "build_started",
    fromEvent: "build_started",
    gapMs: UNDER_SLA_MS,
    slaMs: BUILD_STARTED_TO_BUILD_DONE_SLA_MS,
  });
  assert.equal(surfaced, false);
});

test("Original threshold still surfaces — build_done→phase_shipped is unchanged by Phase 1", () => {
  // The Phase-1 migration is ADDITIVE: `INSERT ... ON CONFLICT DO NOTHING`. The
  // pre-existing threshold's surfacing MUST NOT regress. A build_done spec whose
  // phase_shipped never followed within the finish-side SLA is still surfaced.
  const surfaced = matchesMarioThresholdForOverdueTransition({
    lastEventKind: "build_done",
    fromEvent: "build_done",
    gapMs: BUILD_DONE_TO_PHASE_SHIPPED_SLA_MS + 1,
    slaMs: BUILD_DONE_TO_PHASE_SHIPPED_SLA_MS,
  });
  assert.equal(surfaced, true);
});

test("Cross-threshold noise — a build_started candidate is NOT surfaced under the finish-side threshold", () => {
  // The evaluator loops (threshold × candidate). Even with BOTH thresholds present,
  // a build_started spec's `last_event_kind` matches only the new threshold —
  // never the finish-side one. Prevents a future dedup change from silently
  // double-surfacing the same spec under two thresholds.
  const surfaced = matchesMarioThresholdForOverdueTransition({
    lastEventKind: "build_started",
    fromEvent: "build_done",
    gapMs: OVER_SLA_MS,
    slaMs: BUILD_DONE_TO_PHASE_SHIPPED_SLA_MS,
  });
  assert.equal(surfaced, false);
});
