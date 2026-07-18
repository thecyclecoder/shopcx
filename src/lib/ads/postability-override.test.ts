/**
 * Unit tests for the CEO postability override SDK — the pure predicates + the
 * normalization helpers used by the API layer. The DB-write cases live at the
 * gate seam in src/lib/media-buyer/publish-gate.max-copy-qc.test.ts (where they
 * exercise the full read-through-then-classify path); this file pins the small
 * pure surface that guards the write's inputs.
 *
 * bianca-posts-only-at-9of10-plus-ceo-manual-score-override-oversight-gate Phase 2.
 *
 * Run:
 *   npx tsx --test src/lib/ads/postability-override.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isPostabilityOverrideActive,
  normalizeOverrideReason,
  normalizeOverrideScore,
} from "./postability-override";

// ── isPostabilityOverrideActive ──────────────────────────────────────────────

test("isPostabilityOverrideActive — null record → false (no override in play)", () => {
  assert.equal(isPostabilityOverrideActive(null), false);
});

test("isPostabilityOverrideActive — all-null record → false (row exists but no override set)", () => {
  assert.equal(
    isPostabilityOverrideActive({
      override_postable: null,
      override_score: null,
      override_reason: null,
      override_by: null,
      override_at: null,
    }),
    false,
  );
});

test("isPostabilityOverrideActive — override_postable=true → true (CEO said post)", () => {
  assert.equal(
    isPostabilityOverrideActive({
      override_postable: true,
      override_score: 9,
      override_reason: "CEO judgment call",
      override_by: "user-ceo",
      override_at: "2026-07-18T12:00:00Z",
    }),
    true,
  );
});

test("isPostabilityOverrideActive — override_postable=false → false (there is no false override; only true or absent — the migration comment pins the semantics)", () => {
  assert.equal(
    isPostabilityOverrideActive({
      override_postable: false,
      override_score: 9,
      override_reason: "stale",
      override_by: "user-x",
      override_at: "2026-07-18T12:00:00Z",
    }),
    false,
  );
});

// ── normalizeOverrideReason ──────────────────────────────────────────────────

test("normalizeOverrideReason — null/undefined → null (API layer surfaces missing_reason)", () => {
  assert.equal(normalizeOverrideReason(null), null);
  assert.equal(normalizeOverrideReason(undefined), null);
});

test("normalizeOverrideReason — empty string / whitespace only → null (no meaningful reason)", () => {
  assert.equal(normalizeOverrideReason(""), null);
  assert.equal(normalizeOverrideReason("   "), null);
  assert.equal(normalizeOverrideReason("\n\t "), null);
});

test("normalizeOverrideReason — non-empty string → trimmed", () => {
  assert.equal(normalizeOverrideReason("  CEO judgment call  "), "CEO judgment call");
});

test("normalizeOverrideReason — overlong string → truncated to 1000 chars", () => {
  const long = "x".repeat(2000);
  const out = normalizeOverrideReason(long);
  assert.equal(out?.length, 1000);
});

// ── normalizeOverrideScore ───────────────────────────────────────────────────

test("normalizeOverrideScore — null/undefined/NaN → null", () => {
  assert.equal(normalizeOverrideScore(null), null);
  assert.equal(normalizeOverrideScore(undefined), null);
  assert.equal(normalizeOverrideScore(Number.NaN), null);
});

test("normalizeOverrideScore — in-range integers pass through", () => {
  assert.equal(normalizeOverrideScore(0), 0);
  assert.equal(normalizeOverrideScore(9), 9);
  assert.equal(normalizeOverrideScore(10), 10);
});

test("normalizeOverrideScore — out-of-range values clamp to 0..10", () => {
  assert.equal(normalizeOverrideScore(-3), 0);
  assert.equal(normalizeOverrideScore(42), 10);
});

test("normalizeOverrideScore — non-integer values truncate (guards the DB CHECK)", () => {
  assert.equal(normalizeOverrideScore(9.7), 9);
});
