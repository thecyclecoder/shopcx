/**
 * Unit tests for the pure regression detector in [[./self-correcting]] — pins the
 * right-to-left trailing-streak math so the auto-disarm ONLY fires on a sustained
 * grade regression (media-buyer-self-correcting-mode-revert Phase 1 verification).
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/self-correcting.test.ts
 *   npm run test:media-buyer-self-correcting
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  REGRESSION_GRADE_THRESHOLD,
  REGRESSION_STREAK_DAYS,
  bucketGradesByDay,
  detectMediaBuyerRegression,
  type DailyGradeBucket,
} from "./self-correcting";

const bucket = (day: string, avg: number, count = 3): DailyGradeBucket => ({
  day,
  avg_overall_grade: avg,
  count,
});

// ── Streak-length base cases ──────────────────────────────────────────────────

test("detectMediaBuyerRegression — 8-day trailing streak of avg 4 with count≥2 → regressed", () => {
  const days = Array.from({ length: 8 }, (_, i) => bucket(`2026-07-0${i + 1}`, 4));
  const signals = detectMediaBuyerRegression(days);
  assert.equal(signals.streakDays, 8);
  assert.equal(signals.regressed, true);
  assert.equal(signals.streakAvgOverallGrade, 4);
});

test("detectMediaBuyerRegression — 7-day trailing streak clears exactly at the threshold", () => {
  const days = Array.from({ length: 7 }, (_, i) => bucket(`2026-07-0${i + 1}`, 3));
  const signals = detectMediaBuyerRegression(days);
  assert.equal(signals.streakDays, 7);
  assert.equal(signals.regressed, true);
});

test("detectMediaBuyerRegression — 6-day trailing streak does NOT trip (below required)", () => {
  const days = Array.from({ length: 6 }, (_, i) => bucket(`2026-07-0${i + 1}`, 4));
  const signals = detectMediaBuyerRegression(days);
  assert.equal(signals.streakDays, 6);
  assert.equal(signals.regressed, false);
});

// ── Threshold predicate ───────────────────────────────────────────────────────

test("detectMediaBuyerRegression — a day at exactly the threshold (5) is NOT below → breaks streak", () => {
  // Last 7 days: [4,4,4,4,4,4, 5]. avg=5 fails `< 5` → streak count=0 (trailing day breaks first).
  const days = [
    bucket("2026-07-01", 4),
    bucket("2026-07-02", 4),
    bucket("2026-07-03", 4),
    bucket("2026-07-04", 4),
    bucket("2026-07-05", 4),
    bucket("2026-07-06", 4),
    bucket("2026-07-07", REGRESSION_GRADE_THRESHOLD),
  ];
  const signals = detectMediaBuyerRegression(days);
  assert.equal(signals.streakDays, 0);
  assert.equal(signals.regressed, false);
});

// ── Noise guard (≥2 count) ────────────────────────────────────────────────────

test("detectMediaBuyerRegression — an 8-day run interrupted by a single 1-count day breaks the streak", () => {
  // The 3rd-from-latest day has only 1 graded action → breaks the streak going right-to-left.
  const days = [
    bucket("2026-07-01", 3),
    bucket("2026-07-02", 3),
    bucket("2026-07-03", 3),
    bucket("2026-07-04", 3),
    bucket("2026-07-05", 3),
    bucket("2026-07-06", 3, 1), // ← count=1 breaks the trailing streak here
    bucket("2026-07-07", 3),
    bucket("2026-07-08", 3),
  ];
  const signals = detectMediaBuyerRegression(days);
  // Right-to-left: 08, 07 pass (count=3, avg<5) → streak=2, then 06 breaks (count=1).
  assert.equal(signals.streakDays, 2);
  assert.equal(signals.regressed, false);
});

test("detectMediaBuyerRegression — a single healthy day interrupts an otherwise 8-day run", () => {
  const days = [
    bucket("2026-07-01", 3),
    bucket("2026-07-02", 3),
    bucket("2026-07-03", 3),
    bucket("2026-07-04", 6), // ← healthy day resets the streak walking backward
    bucket("2026-07-05", 3),
    bucket("2026-07-06", 3),
    bucket("2026-07-07", 3),
    bucket("2026-07-08", 3),
  ];
  const signals = detectMediaBuyerRegression(days);
  // Trailing 4 days [05..08] pass, then 04 breaks (avg=6 not <5).
  assert.equal(signals.streakDays, 4);
  assert.equal(signals.regressed, false);
});

// ── Empty / degenerate ────────────────────────────────────────────────────────

test("detectMediaBuyerRegression — empty buckets → streakDays=0, regressed=false, avg NaN", () => {
  const signals = detectMediaBuyerRegression([]);
  assert.equal(signals.streakDays, 0);
  assert.equal(signals.regressed, false);
  assert.ok(Number.isNaN(signals.streakAvgOverallGrade));
});

test("detectMediaBuyerRegression — REGRESSION_STREAK_DAYS is the documented 7-day requirement", () => {
  assert.equal(REGRESSION_STREAK_DAYS, 7);
});

// ── bucketGradesByDay ─────────────────────────────────────────────────────────

test("bucketGradesByDay — rolls per-day averages in chronological order + preserves counts", () => {
  const rows = [
    { overall_grade: 3, graded_at: "2026-07-01T10:00:00Z", meta_ad_account_id: null },
    { overall_grade: 5, graded_at: "2026-07-01T14:00:00Z", meta_ad_account_id: null },
    { overall_grade: 4, graded_at: "2026-07-02T09:00:00Z", meta_ad_account_id: null },
  ];
  const buckets = bucketGradesByDay(rows);
  assert.deepEqual(buckets, [
    { day: "2026-07-01", avg_overall_grade: 4, count: 2 },
    { day: "2026-07-02", avg_overall_grade: 4, count: 1 },
  ]);
});

test("bucketGradesByDay — skips non-finite overall_grade rows", () => {
  const rows = [
    { overall_grade: Number.NaN, graded_at: "2026-07-01T00:00:00Z", meta_ad_account_id: null },
    { overall_grade: 4, graded_at: "2026-07-01T01:00:00Z", meta_ad_account_id: null },
  ];
  const buckets = bucketGradesByDay(rows);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].count, 1);
  assert.equal(buckets[0].avg_overall_grade, 4);
});
