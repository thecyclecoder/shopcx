/**
 * Unit tests for the spec-read-egress-scope-and-cursor read path — the scope derivation and the
 * probe-validated whole-board cache behind `listSpecs`.
 *
 * Named failing state: every whole-board reader re-shipped all 662 specs (5.14 MB, 68.7% of it the
 * joined `phases` jsonb) on every call. Measured 2026-07-20 over a 12-day pg_stat_statements
 * window: 238,379 calls / 150,011,498 rows on `list_specs_with_phases` ≈ 97 GB/day — the largest
 * single egress driver on the project. `scope='active'` returns 8 rows / 0.05 MB for the same
 * readers, and the `p_since` change-probe was already built but never wired into the SDK.
 *
 * These tests pin the two pieces where a mistake is SILENT rather than loud: a scope narrowed too
 * far drops specs from a board, and a cache served too eagerly shows stale specs after a write.
 *
 * Pure helpers — no I/O, no DB. Run:
 *   npx tsx --test src/lib/specs-table.list-egress.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideListSpecsCache,
  probeSaysUnchanged,
  scopeForFilter,
} from "@/lib/specs-table";

// ── scopeForFilter ───────────────────────────────────────────────────────────
// Equivalence rests on specs_status_check (status IS NULL OR status IN ('deferred','folded')) plus
// specRowFromDb passing `status` through verbatim from the stored column.

test("no filter → 'all' (unchanged folded-inclusive default)", () => {
  assert.equal(scopeForFilter({}), "all");
});

test("status='folded' → 'archived' — exactly the rows the RPC's archived predicate returns", () => {
  assert.equal(scopeForFilter({ status: "folded" }), "archived");
});

test("status='deferred' → 'active' — deferred is non-folded, so it lives inside active", () => {
  assert.equal(scopeForFilter({ status: "deferred" }), "active");
});

// The derived lifecycle values the CHECK constraint forbids in the column. We must NOT narrow
// these: if the constraint is ever widened, an un-narrowed 'all' stays correct where a narrowed
// scope would silently drop rows.
for (const status of ["in_review", "planned", "in_progress", "shipped"] as const) {
  test(`status='${status}' → 'all' (never narrowed — cheapness must not outrank correctness)`, () => {
    assert.equal(scopeForFilter({ status }), "all");
  });
}

test("an explicit scope always wins over status-derived narrowing", () => {
  assert.equal(scopeForFilter({ status: "folded", scope: "all" }), "all");
  assert.equal(scopeForFilter({ status: "deferred", scope: "archived" }), "archived");
});

test("a non-status filter does not narrow the scope", () => {
  assert.equal(scopeForFilter({ owner: "platform" }), "all");
  assert.equal(scopeForFilter({ milestone_id: null }), "all");
});

// ── decideListSpecsCache ─────────────────────────────────────────────────────

test("no entry → fetch", () => {
  assert.equal(decideListSpecsCache(undefined, 1_000), "fetch");
});

test("inside the TTL → fresh (serve cached rows, zero I/O)", () => {
  assert.equal(decideListSpecsCache({ expiresAt: 2_000, maxUpdatedAt: new Date(0) }, 1_999), "fresh");
});

test("expired WITH a high-water mark → probe (one index-only scan beats 5.14 MB)", () => {
  assert.equal(decideListSpecsCache({ expiresAt: 2_000, maxUpdatedAt: new Date(0) }, 2_000), "probe");
});

test("expired WITHOUT a high-water mark → fetch (nothing to compare against)", () => {
  assert.equal(decideListSpecsCache({ expiresAt: 2_000, maxUpdatedAt: null }, 5_000), "fetch");
});

test("expiry boundary is exclusive — exactly-at-expiry is no longer fresh", () => {
  const entry = { expiresAt: 2_000, maxUpdatedAt: new Date(0) };
  assert.equal(decideListSpecsCache(entry, 1_999), "fresh");
  assert.notEqual(decideListSpecsCache(entry, 2_000), "fresh");
});

// ── probeSaysUnchanged ───────────────────────────────────────────────────────

test("probe older than the mark → unchanged (serve cache)", () => {
  assert.equal(probeSaysUnchanged(new Date(1_000), new Date(2_000)), true);
});

test("probe EQUAL to the mark → unchanged — the mark is captured after the rows", () => {
  assert.equal(probeSaysUnchanged(new Date(2_000), new Date(2_000)), true);
});

test("probe newer than the mark → changed (re-fetch)", () => {
  assert.equal(probeSaysUnchanged(new Date(2_001), new Date(2_000)), false);
});

test("a null probe (pool blip) is NEVER treated as unchanged — over-fetch beats serving stale", () => {
  assert.equal(probeSaysUnchanged(null, new Date(2_000)), false);
});

test("a null mark is never unchanged either", () => {
  assert.equal(probeSaysUnchanged(new Date(1_000), null), false);
});
