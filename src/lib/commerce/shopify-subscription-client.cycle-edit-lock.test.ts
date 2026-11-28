/**
 * Unit tests for isLockingEditedCycle — which edited billing cycle holds the contract update lock.
 *   npx tsx --test src/lib/commerce/shopify-subscription-client.cycle-edit-lock.test.ts
 *
 * The lock-lift helper used to only consider UNBILLED cycles, so a contract whose CURRENT
 * (already-billed, not-yet-ended) cycle carried a gift edit stayed blocked — Kristina's cancel
 * (contract 54313320621, index 2) failed 2026-11-27 until the edit was deleted by hand. The rule:
 * an edited cycle locks when it is UNBILLED, or BILLED but its period has not ended yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isLockingEditedCycle } from "./shopify-subscription-client";

const NOW = new Date("2026-11-27T00:00:00.000Z");

test("UNBILLED edited cycle locks (no cycleEndAt needed)", () => {
  assert.equal(isLockingEditedCycle({ edited: true, status: "UNBILLED" }, NOW), true);
});

test("current BILLED edited cycle (period not ended) locks", () => {
  // Kristina's live case: billed on 2026-11-17, ends 2026-12-15, now 2026-11-27.
  assert.equal(
    isLockingEditedCycle({ edited: true, status: "BILLED", cycleEndAt: "2026-12-15T00:00:00.000Z" }, NOW),
    true,
  );
});

test("past BILLED edited cycle (period already ended) does NOT lock", () => {
  assert.equal(
    isLockingEditedCycle({ edited: true, status: "BILLED", cycleEndAt: "2026-11-15T00:00:00.000Z" }, NOW),
    false,
  );
});

test("BILLED edited cycle without a cycleEndAt does NOT lock (cannot prove it is current)", () => {
  assert.equal(isLockingEditedCycle({ edited: true, status: "BILLED" }, NOW), false);
});

test("un-edited cycle never locks, whatever its status", () => {
  assert.equal(isLockingEditedCycle({ edited: false, status: "UNBILLED" }, NOW), false);
  assert.equal(
    isLockingEditedCycle({ edited: false, status: "BILLED", cycleEndAt: "2026-12-15T00:00:00.000Z" }, NOW),
    false,
  );
});
