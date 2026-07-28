/**
 * Unit tests for a-verification-check-must-not-demand-a-name-the-builder-has-to-guess Phase 2 —
 * the pure `detectSuspectCheck` predicate + escalation summary formatter. Pure functions — no DB.
 *
 *   npx tsx --test src/lib/build/suspect-check.test.ts
 *
 * The bar: the detector fires ONLY on the exact recurrence shape the spec calls out — a lone
 * failing check that has been the ONLY failing check across ≥ threshold consecutive builds. Any
 * ambiguity (multiple failing checks, streak-broken by a different key, prior run with no failures)
 * fails CLOSED with `null` so the escalation stays as-is; the detector never falsely relabels a
 * genuine build defect as a bad check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectSuspectCheck, formatSuspectCheckSummary, DEFAULT_SUSPECT_CHECK_THRESHOLD } from "./suspect-check";

test("detectSuspectCheck fires when the SAME lone check has failed >=threshold consecutive builds", () => {
  // The exact shape observed on bianca-actually-graduates-crowned-winners-... — 5 identical builds
  // all failing only on the `test:graduate-crowned` grep. threshold=3, we have 3 total.
  const res = detectSuspectCheck({
    currentFailingKeys: ["k:test-graduate-crowned"],
    priorRuns: [
      { at: "2026-07-28T10:00:00.000Z", failingKeys: ["k:test-graduate-crowned"] },
      { at: "2026-07-28T09:00:00.000Z", failingKeys: ["k:test-graduate-crowned"] },
    ],
  });
  assert.ok(res, "3 consecutive lone-key failures must fire");
  assert.equal(res!.checkKey, "k:test-graduate-crowned");
  assert.equal(res!.count, 3);
  assert.equal(res!.threshold, DEFAULT_SUSPECT_CHECK_THRESHOLD);
});

test("detectSuspectCheck does NOT fire when the current run has multiple failing checks (real code miss)", () => {
  // A phase failing on 2+ checks in one build is nearly always a real code miss — never a bad check.
  const res = detectSuspectCheck({
    currentFailingKeys: ["k:test-graduate-crowned", "k:hero-image-present"],
    priorRuns: [
      { at: "2026-07-28T10:00:00Z", failingKeys: ["k:test-graduate-crowned"] },
      { at: "2026-07-28T09:00:00Z", failingKeys: ["k:test-graduate-crowned"] },
    ],
  });
  assert.equal(res, null, "multi-failure current run must NOT flag as suspect-check");
});

test("detectSuspectCheck does NOT fire when a prior run failed on a DIFFERENT key (streak broken)", () => {
  const res = detectSuspectCheck({
    currentFailingKeys: ["k:test-graduate-crowned"],
    priorRuns: [
      { at: "2026-07-28T10:00:00Z", failingKeys: ["k:test-graduate-crowned"] },
      { at: "2026-07-28T09:00:00Z", failingKeys: ["k:some-other-check"] }, // streak-breaker
    ],
  });
  assert.equal(res, null, "a different-key prior break must NOT be a suspect check");
});

test("detectSuspectCheck does NOT fire when a prior run had multiple failing keys (streak broken)", () => {
  const res = detectSuspectCheck({
    currentFailingKeys: ["k:test-graduate-crowned"],
    priorRuns: [
      { at: "2026-07-28T10:00:00Z", failingKeys: ["k:test-graduate-crowned"] },
      { at: "2026-07-28T09:00:00Z", failingKeys: ["k:test-graduate-crowned", "k:other"] }, // multi
    ],
  });
  assert.equal(res, null, "a multi-fail prior run must break the streak");
});

test("detectSuspectCheck does NOT fire with too-short history", () => {
  const res = detectSuspectCheck({
    currentFailingKeys: ["k:test-graduate-crowned"],
    priorRuns: [], // no history — can't infer a pattern
  });
  assert.equal(res, null, "no prior runs → not enough evidence, must NOT flag");
});

test("detectSuspectCheck orders prior runs newest → oldest regardless of input order", () => {
  // Same underlying history — but the caller may have passed either order. Result must be identical.
  const shared = [
    { at: "2026-07-28T09:00:00Z", failingKeys: ["k:x"] },
    { at: "2026-07-28T10:00:00Z", failingKeys: ["k:x"] },
  ];
  const ascending = detectSuspectCheck({ currentFailingKeys: ["k:x"], priorRuns: shared });
  const descending = detectSuspectCheck({ currentFailingKeys: ["k:x"], priorRuns: [...shared].reverse() });
  assert.deepEqual(descending, ascending, "ordering the input must not change the verdict");
  assert.ok(ascending);
});

test("detectSuspectCheck honors a custom threshold", () => {
  // threshold=2 → current + one prior is enough.
  const res = detectSuspectCheck({
    currentFailingKeys: ["k:x"],
    priorRuns: [{ at: "2026-07-28T10:00:00Z", failingKeys: ["k:x"] }],
    threshold: 2,
  });
  assert.ok(res);
  assert.equal(res!.count, 2);
  assert.equal(res!.threshold, 2);
});

test("detectSuspectCheck rejects meaningless thresholds", () => {
  assert.equal(
    detectSuspectCheck({ currentFailingKeys: ["k:x"], priorRuns: [], threshold: 1 }),
    null,
    "threshold=1 is meaningless (a single failure is not a pattern)",
  );
  assert.equal(
    detectSuspectCheck({ currentFailingKeys: [""], priorRuns: [] }),
    null,
    "empty-string key rejects",
  );
});

test("formatSuspectCheckSummary produces the 'check is the likely defect' escalation text", () => {
  const summary = formatSuspectCheckSummary({
    slug: "bianca-actually-graduates-crowned-winners",
    suspect: { checkKey: "k:test-graduate-crowned", count: 5, threshold: 3 },
    checkDescription: "package.json registers a test:graduate-crowned npm script",
    phasePosition: 1,
    checkPosition: 2,
    failingPattern: "test:graduate-crowned",
    suggestedPattern: "test:.*graduate",
    nearMissEvidence: "package.json contains: test:media-buyer-graduate-scaler, test:cold-scaler-graduate-heartbeat",
  });
  assert.match(summary, /check 2 of phase 1 has failed 5 builds/);
  assert.match(summary, /every other check passed/);
  assert.match(summary, /the check is the likely defect/);
  assert.match(summary, /Branch DOES contain a near-miss/);
  assert.match(summary, /test:media-buyer-graduate-scaler/);
  assert.match(summary, /Remedy — loosen the check/);
  assert.match(summary, /test:\.\*graduate/);
});

test("formatSuspectCheckSummary works when only the suggested pattern is known", () => {
  const summary = formatSuspectCheckSummary({
    slug: "s",
    suspect: { checkKey: "k", count: 3, threshold: 3 },
    checkDescription: "kebab-case name present",
    phasePosition: 2,
    checkPosition: 1,
    suggestedPattern: "(?i)\\bquant\\b",
  });
  assert.match(summary, /Remedy — loosen the check to: \(\?i\)\\bquant\\b/);
});
