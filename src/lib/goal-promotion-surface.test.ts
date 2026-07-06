/**
 * Unit tests for the goal-promotion HELD surface derivation
 * (goal-promotion-fold-collision-and-held-surfacing Phase 2). Pins the STATES the spec verification calls
 * out — a goal whose atomic promotion 409s reads HELD (not complete) with the reason, and a folded goal
 * whose merge_sha is null does NOT display as fully shipped.
 *
 * Pure helper — no I/O. Run:
 *   npx tsx --test src/lib/goal-promotion-surface.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveGoalPromotionSurface } from "./goal-promotion-surface";

// ── SPEC VERIFICATION #1: a goal whose atomic promotion 409s shows HELD/needs-owner (not shipped) with the reason ──

test("a stored `promotion_held_reason` from a 409 → HELD, cardStatus forced OFF `complete`, reason surfaced", () => {
  const out = deriveGoalPromotionSurface({
    storedStatus: "greenlit",
    derivedComplete: true, // all milestones rolled up — was ABOUT to atomic-promote when M5 409'd.
    exempt: false,
    mainMergeSha: null,
    promotionHeldReason: "conflict: docs/brain/lifecycles/commerce-sdk.md add/add",
  });
  assert.equal(out.promotionHeld, true);
  assert.equal(out.cardStatus, "greenlit"); // NEVER 'complete' while HELD
  assert.equal(out.promotionHeldReason, "conflict: docs/brain/lifecycles/commerce-sdk.md add/add");
});

test("blank/whitespace `promotion_held_reason` is NOT treated as HELD (defensive against a cleared reason)", () => {
  const out = deriveGoalPromotionSurface({
    storedStatus: "greenlit",
    derivedComplete: false,
    exempt: false,
    mainMergeSha: null,
    promotionHeldReason: "   ",
  });
  assert.equal(out.promotionHeld, false);
  assert.equal(out.cardStatus, "greenlit");
});

// ── SPEC VERIFICATION #2: a folded/complete goal whose merge_sha is null does NOT display as fully shipped ──

test("the incident shape — stored `folded` + null main_merge_sha → HELD (silent-stall backstop), NOT complete", () => {
  // The 2026-07-06 centralized-commerce-sdk case: goal-fold flipped stored → 'folded' off the derived
  // rollup, but `mergeGoalBranchIntoMain` never actually landed the goal branch. The reader MUST detect
  // "code isn't on main" and refuse to render this as shipped.
  const out = deriveGoalPromotionSurface({
    storedStatus: "folded",
    derivedComplete: true,
    exempt: false,
    mainMergeSha: null,
    promotionHeldReason: null,
  });
  assert.equal(out.promotionHeld, true);
  assert.equal(out.cardStatus, "greenlit"); // NEVER 'complete' — the whole point of the backstop.
  assert.ok(out.promotionHeldReason.length > 0);
});

test("stored `complete` + null main_merge_sha → HELD (backstop covers the pre-fold shape too)", () => {
  const out = deriveGoalPromotionSurface({
    storedStatus: "complete",
    derivedComplete: true,
    exempt: false,
    mainMergeSha: null,
    promotionHeldReason: null,
  });
  assert.equal(out.promotionHeld, true);
  assert.equal(out.cardStatus, "greenlit");
});

test("derivedComplete + null main_merge_sha → HELD even when stored is still `greenlit` (rollup landed, atomic didn't)", () => {
  const out = deriveGoalPromotionSurface({
    storedStatus: "greenlit",
    derivedComplete: true,
    exempt: false,
    mainMergeSha: null,
    promotionHeldReason: null,
  });
  assert.equal(out.promotionHeld, true);
  assert.equal(out.cardStatus, "greenlit");
});

// ── HAPPY PATH: a genuinely-promoted goal renders complete and NOT held ──

test("stored `folded` + a real main_merge_sha → NOT held; cardStatus reflects the derived rollup (complete)", () => {
  const out = deriveGoalPromotionSurface({
    storedStatus: "folded",
    derivedComplete: true,
    exempt: false,
    mainMergeSha: "deadbeef" + "00".repeat(16),
    promotionHeldReason: null,
  });
  assert.equal(out.promotionHeld, false);
  assert.equal(out.cardStatus, "complete");
  assert.equal(out.promotionHeldReason, "");
});

test("stored `complete` + a real main_merge_sha → NOT held; renders complete", () => {
  const out = deriveGoalPromotionSurface({
    storedStatus: "complete",
    derivedComplete: true,
    exempt: false,
    mainMergeSha: "abc123",
    promotionHeldReason: null,
  });
  assert.equal(out.promotionHeld, false);
  assert.equal(out.cardStatus, "complete");
});

// ── EXEMPT GOALS never atomic-promote → never HELD, even with the incident shape ──

test("EXEMPT parent goal — HELD never applies regardless of merge SHA / stored status", () => {
  const out = deriveGoalPromotionSurface({
    storedStatus: "folded",
    derivedComplete: true,
    exempt: true, // parent goal / has sub-goals / no buildable specs
    mainMergeSha: null,
    promotionHeldReason: "would-be conflict",
  });
  assert.equal(out.promotionHeld, false);
  assert.equal(out.cardStatus, "complete");
});

// ── IN-PROGRESS AND PROPOSED GOALS: no atomic-promote yet, no HELD ──

test("a `proposed` goal with no rollup + no merge SHA → NOT held, cardStatus stays `proposed`", () => {
  const out = deriveGoalPromotionSurface({
    storedStatus: "proposed",
    derivedComplete: false,
    exempt: false,
    mainMergeSha: null,
    promotionHeldReason: null,
  });
  assert.equal(out.promotionHeld, false);
  assert.equal(out.cardStatus, "proposed");
});

test("a `greenlit` goal mid-build (not derivedComplete, no merge SHA) → NOT held, cardStatus stays `greenlit`", () => {
  const out = deriveGoalPromotionSurface({
    storedStatus: "greenlit",
    derivedComplete: false,
    exempt: false,
    mainMergeSha: null,
    promotionHeldReason: null,
  });
  assert.equal(out.promotionHeld, false);
  assert.equal(out.cardStatus, "greenlit");
});
