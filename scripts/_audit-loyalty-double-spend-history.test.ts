/**
 * Unit test for the Phase-3 loyalty double-spend audit script.
 *
 * Two guarantees enforced here:
 *
 * (a) `clusterOverDeductions` correctly detects the durable fingerprint
 *     (two-or-more same-magnitude spending rows for one member within
 *     the window) and skips lone rows / cross-member coincidences /
 *     out-of-window pairs. Susan's Jun 11 / Jun 25 / Jul 09 patterns
 *     each surface exactly one cluster.
 *
 * (b) The audit script is FOUNDER-GATED — the spec's key invariant:
 *     "NO mass point-refund executes". This is enforced by grepping the
 *     script for any mutating call (`.insert(`, `.update(`, `.delete(`,
 *     `spendPoints`, `addPoints`, `deductPoints`, `earnPoints`). Zero
 *     is the only passing state. If a future edit adds a mutation, this
 *     test reds and forces a review.
 *
 * Run:
 *   npx tsx --test scripts/_audit-loyalty-double-spend-history.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clusterOverDeductions } from "./_audit-loyalty-double-spend-history";

type SpendRow = {
  id: string;
  workspace_id: string;
  member_id: string;
  points_change: number;
  description: string;
  created_at: string;
  shopify_discount_id: string | null;
};

function row(overrides: Partial<SpendRow>): SpendRow {
  return {
    id: overrides.id ?? `tx-${Math.random().toString(36).slice(2, 8)}`,
    workspace_id: overrides.workspace_id ?? "ws-superfoods",
    member_id: overrides.member_id ?? "mem-susan",
    points_change: overrides.points_change ?? -1500,
    description: overrides.description ?? "Redeemed $15 Off (regenerated)",
    created_at: overrides.created_at ?? "2026-07-09T12:00:00.000Z",
    shopify_discount_id: overrides.shopify_discount_id ?? null,
  };
}

test("clusterOverDeductions: Susan Jul 09 — two rows within 12s → one cluster of size 2, over_deducted=1500", () => {
  const rows: SpendRow[] = [
    row({ id: "s1", created_at: "2026-07-09T12:00:00.000Z" }),
    row({ id: "s2", created_at: "2026-07-09T12:00:12.000Z" }),
  ];
  const clusters = clusterOverDeductions(rows, 60);
  assert.equal(clusters.length, 1, "one cluster");
  assert.equal(clusters[0]!.duplicate_count, 1, "one extra spend beyond the first");
  assert.equal(clusters[0]!.over_deducted_points, 1500);
  assert.equal(clusters[0]!.window_seconds, 12);
  assert.deepEqual(clusters[0]!.row_ids, ["s1", "s2"]);
});

test("clusterOverDeductions: Susan Jun 11 — three rows within 30s → one cluster of size 3, over_deducted=3000", () => {
  const rows: SpendRow[] = [
    row({ id: "j1", created_at: "2026-06-11T14:00:00.000Z" }),
    row({ id: "j2", created_at: "2026-06-11T14:00:10.000Z" }),
    row({ id: "j3", created_at: "2026-06-11T14:00:22.000Z" }),
  ];
  const clusters = clusterOverDeductions(rows, 60);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.duplicate_count, 2, "three rows = one legitimate + two duplicates");
  assert.equal(clusters[0]!.over_deducted_points, 3000);
});

test("clusterOverDeductions: a single lone spending row is NOT a cluster (min size = 2)", () => {
  const rows: SpendRow[] = [row({ id: "lone", created_at: "2026-06-25T09:00:00.000Z" })];
  const clusters = clusterOverDeductions(rows, 60);
  assert.equal(clusters.length, 0, "lone spends are legitimate — never flagged");
});

test("clusterOverDeductions: two rows OUTSIDE the window → NOT a cluster (window guards against unrelated separate applies)", () => {
  const rows: SpendRow[] = [
    row({ id: "far1", created_at: "2026-06-25T09:00:00.000Z" }),
    row({ id: "far2", created_at: "2026-06-25T09:05:00.000Z" }), // 5 min gap > 60s window
  ];
  const clusters = clusterOverDeductions(rows, 60);
  assert.equal(clusters.length, 0, "spends outside the window are two distinct applies, not a double-deduct");
});

test("clusterOverDeductions: two rows for DIFFERENT members within the window → NOT a cluster (per-member key)", () => {
  const rows: SpendRow[] = [
    row({ id: "a", member_id: "mem-alice", created_at: "2026-07-09T12:00:00.000Z" }),
    row({ id: "b", member_id: "mem-bob",   created_at: "2026-07-09T12:00:05.000Z" }),
  ];
  const clusters = clusterOverDeductions(rows, 60);
  assert.equal(clusters.length, 0, "the fingerprint is per-member — cross-member concurrent regens are not double-deducts");
});

test("clusterOverDeductions: two rows for DIFFERENT magnitudes within the window → NOT a cluster (different tier)", () => {
  const rows: SpendRow[] = [
    row({ id: "big",   points_change: -1500, created_at: "2026-07-09T12:00:00.000Z" }),
    row({ id: "small", points_change: -500,  created_at: "2026-07-09T12:00:05.000Z" }),
  ];
  const clusters = clusterOverDeductions(rows, 60);
  assert.equal(clusters.length, 0, "different tiers are different applies — the gate keys per magnitude");
});

test("clusterOverDeductions: mixed input — sorts internally and produces correct per-member clusters", () => {
  const rows: SpendRow[] = [
    // Interleaved input order
    row({ id: "alice2", member_id: "mem-alice", created_at: "2026-07-09T12:00:15.000Z" }),
    row({ id: "bob1",   member_id: "mem-bob",   created_at: "2026-07-09T12:00:00.000Z" }),
    row({ id: "alice1", member_id: "mem-alice", created_at: "2026-07-09T12:00:00.000Z" }),
    row({ id: "bob2",   member_id: "mem-bob",   created_at: "2026-07-09T12:00:10.000Z" }),
  ];
  const clusters = clusterOverDeductions(rows, 60);
  assert.equal(clusters.length, 2, "two per-member clusters — internal sort is order-independent");
  const byMember = Object.fromEntries(clusters.map((c) => [c.member_id, c]));
  assert.equal(byMember["mem-alice"]!.duplicate_count, 1);
  assert.equal(byMember["mem-bob"]!.duplicate_count, 1);
});

// ── invariant: the audit script is READ-ONLY ────────────────────────

test("audit script is READ-ONLY — no mutating calls, no mass refund path (spec's founder-gated invariant)", () => {
  const src = readFileSync(resolve(__dirname, "_audit-loyalty-double-spend-history.ts"), "utf-8");

  // Strip block comments and single-line comments so the docstring's
  // references to writes (grep hints, "no addPoints", etc.) don't
  // trip the scan.
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  const forbidden: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /\.insert\s*\(/, label: ".insert(" },
    { pattern: /\.update\s*\(/, label: ".update(" },
    { pattern: /\.delete\s*\(/, label: ".delete(" },
    { pattern: /\.upsert\s*\(/, label: ".upsert(" },
    { pattern: /\bspendPoints\s*\(/, label: "spendPoints(" },
    { pattern: /\baddPoints\s*\(/, label: "addPoints(" },
    { pattern: /\bearnPoints\s*\(/, label: "earnPoints(" },
    { pattern: /\bdeductPoints\s*\(/, label: "deductPoints(" },
    { pattern: /\brefund\s*\(/i, label: "refund(" },
  ];
  const hits = forbidden
    .map((f) => ({ label: f.label, matched: f.pattern.test(codeOnly) }))
    .filter((h) => h.matched);
  assert.deepEqual(hits, [], `audit script must contain zero mutating calls — found: ${hits.map((h) => h.label).join(", ")}`);
});
