/**
 * Unit tests for the per-copy-mode leading-signal helper (docs/brain/specs/dahlia-cold-
 * graded-inline-link-ctr-leading-signal.md Phase 2).
 *
 * Pins the three M3-critical invariants from the spec:
 *   (a) author/deterministic split correctness on stubbed rows;
 *   (b) insufficient_data returned when n<PER_COPY_MODE_MIN_N in either bucket;
 *   (c) NULL inline_link_clicks rows are EXCLUDED from the CTR average (numerator AND
 *       denominator), not treated as 0.
 *
 * Run:
 *   npm run test:insights-per-copy-mode
 */
import test from "node:test";
import assert from "node:assert/strict";
import { aggregatePerCopyMode, PER_COPY_MODE_MIN_N } from "./insights";

const WINDOW = { since: "2026-07-03", until: "2026-07-17" };

function grade(overrides: Partial<{ source_meta_ad_id: string; dahlia_copy_mode: "author" | "deterministic" | null; action_kind: string }>) {
  return {
    source_meta_ad_id: overrides.source_meta_ad_id ?? "meta_ad_x",
    dahlia_copy_mode: overrides.dahlia_copy_mode ?? null,
    action_kind: overrides.action_kind ?? "media_buyer_promoted_winner",
    graded_at: "2026-07-16T00:00:00.000Z",
  };
}

function makeBucketRows(prefix: string, mode: "author" | "deterministic", count: number) {
  const grades = [] as ReturnType<typeof grade>[];
  for (let i = 0; i < count; i += 1) {
    grades.push(grade({ source_meta_ad_id: `${prefix}_${i}`, dahlia_copy_mode: mode }));
  }
  return grades;
}

test("(a) split correctness — grades bucket by dahlia_copy_mode", () => {
  const grades = [
    ...makeBucketRows("A", "author", PER_COPY_MODE_MIN_N),
    ...makeBucketRows("D", "deterministic", PER_COPY_MODE_MIN_N),
  ];
  const attribution = [
    ...grades.slice(0, PER_COPY_MODE_MIN_N).map((g) => ({
      meta_ad_id: g.source_meta_ad_id!,
      attributed_spend_cents: 5000,
      orders: 1,
      snapshot_date: "2026-07-16",
    })),
    ...grades.slice(PER_COPY_MODE_MIN_N).map((g) => ({
      meta_ad_id: g.source_meta_ad_id!,
      attributed_spend_cents: 10000,
      orders: 1,
      snapshot_date: "2026-07-16",
    })),
  ];
  const insights = [
    ...grades.slice(0, PER_COPY_MODE_MIN_N).map((g) => ({
      meta_object_id: g.source_meta_ad_id!,
      impressions: 1000,
      inline_link_clicks: 30,
      snapshot_date: "2026-07-16",
    })),
    ...grades.slice(PER_COPY_MODE_MIN_N).map((g) => ({
      meta_object_id: g.source_meta_ad_id!,
      impressions: 1000,
      inline_link_clicks: 20,
      snapshot_date: "2026-07-16",
    })),
  ];

  const result = aggregatePerCopyMode(grades, attribution, insights, WINDOW);
  assert.equal(result.author.n, PER_COPY_MODE_MIN_N);
  assert.equal(result.deterministic.n, PER_COPY_MODE_MIN_N);
  assert.equal(result.author.cac_cents, 5000); // 20 × 5000 / 20 orders
  assert.equal(result.deterministic.cac_cents, 10000); // 20 × 10000 / 20 orders
  assert.equal(result.author.inline_link_ctr, 0.03);
  assert.equal(result.deterministic.inline_link_ctr, 0.02);
  assert.equal(result.delta.cac_cents, -5000); // author is 5000 cents CHEAPER
  assert.equal(result.delta.inline_link_ctr, 0.01);
  assert.equal(result.insufficient_data, false);
});

test("(a1) grade rows with dahlia_copy_mode=null are EXCLUDED (never poison the buckets)", () => {
  const grades = [
    ...makeBucketRows("A", "author", 5),
    grade({ source_meta_ad_id: "unknown_1", dahlia_copy_mode: null }),
    grade({ source_meta_ad_id: "unknown_2", dahlia_copy_mode: null }),
  ];
  const attribution = grades.map((g) => ({
    meta_ad_id: g.source_meta_ad_id!,
    attributed_spend_cents: 5000,
    orders: 1,
    snapshot_date: "2026-07-16",
  }));
  const result = aggregatePerCopyMode(grades, attribution, [], WINDOW);
  assert.equal(result.author.n, 5);
  assert.equal(result.deterministic.n, 0);
  // Two null-mode grades' attribution rows must NOT have leaked into either bucket.
  assert.equal(result.author.attributed_spend_cents, 25_000);
  assert.equal(result.deterministic.attributed_spend_cents, 0);
});

test("(b) insufficient_data flips true when EITHER bucket has n<PER_COPY_MODE_MIN_N", () => {
  const grades = [
    ...makeBucketRows("A", "author", PER_COPY_MODE_MIN_N - 1),
    ...makeBucketRows("D", "deterministic", PER_COPY_MODE_MIN_N + 5),
  ];
  const result = aggregatePerCopyMode(grades, [], [], WINDOW);
  assert.equal(result.insufficient_data, true);
  assert.equal(result.author.n, PER_COPY_MODE_MIN_N - 1);
});

test("(b1) insufficient_data flips true when BOTH buckets are under", () => {
  const grades = [
    ...makeBucketRows("A", "author", 3),
    ...makeBucketRows("D", "deterministic", 3),
  ];
  const result = aggregatePerCopyMode(grades, [], [], WINDOW);
  assert.equal(result.insufficient_data, true);
});

test("(c) NULL inline_link_clicks rows EXCLUDED from both numerator AND denominator", () => {
  // Author bucket sees 2 insight rows: one with (impressions=1000, inline_link_clicks=50) — a
  // real 5% CTR — and one with (impressions=99999, inline_link_clicks=null) — Meta didn't
  // report link clicks that day. The CTR MUST be 50/1000 = 5%, NOT 50/(1000+99999).
  const grades = makeBucketRows("A", "author", PER_COPY_MODE_MIN_N);
  const insights = [
    {
      meta_object_id: grades[0].source_meta_ad_id!,
      impressions: 1000,
      inline_link_clicks: 50,
      snapshot_date: "2026-07-16",
    },
    {
      meta_object_id: grades[0].source_meta_ad_id!,
      impressions: 99999,
      inline_link_clicks: null,
      snapshot_date: "2026-07-15",
    },
  ];
  const result = aggregatePerCopyMode(grades, [], insights, WINDOW);
  assert.equal(result.author.impressions, 1000);
  assert.equal(result.author.inline_link_clicks, 50);
  assert.equal(result.author.inline_link_ctr, 0.05);
});

test("(c1) NULL inline_link_clicks as blank string ALSO EXCLUDED", () => {
  const grades = makeBucketRows("A", "author", PER_COPY_MODE_MIN_N);
  const insights = [
    {
      meta_object_id: grades[0].source_meta_ad_id!,
      impressions: 500,
      inline_link_clicks: 10,
      snapshot_date: "2026-07-16",
    },
    {
      meta_object_id: grades[0].source_meta_ad_id!,
      impressions: 500,
      inline_link_clicks: "",
      snapshot_date: "2026-07-15",
    },
  ];
  const result = aggregatePerCopyMode(grades, [], insights, WINDOW);
  assert.equal(result.author.impressions, 500);
  assert.equal(result.author.inline_link_clicks, 10);
  assert.equal(result.author.inline_link_ctr, 0.02);
});

test("CAC is null when orders=0 (not treated as ∞ or 0)", () => {
  const grades = makeBucketRows("A", "author", PER_COPY_MODE_MIN_N);
  const attribution = [
    {
      meta_ad_id: grades[0].source_meta_ad_id!,
      attributed_spend_cents: 10000,
      orders: 0,
      snapshot_date: "2026-07-16",
    },
  ];
  const result = aggregatePerCopyMode(grades, attribution, [], WINDOW);
  assert.equal(result.author.orders, 0);
  assert.equal(result.author.cac_cents, null);
});
