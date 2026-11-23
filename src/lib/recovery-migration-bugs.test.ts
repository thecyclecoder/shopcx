/**
 * Pins the three 2026-11-23 card-recovery / migration fixes:
 *  1. isStructuralSubscribeAndSave — the contract's "Subscribe & Save" entry is never applied as a
 *     coupon on an internal renewal (the engine already applies S&S; it double-discounted ~25%).
 *  2. isRecentDunningCancel — only a recent dunning cancel is revived on card recovery; a stale
 *     cycle on a sub the customer later cancelled themselves is not.
 *  (3. the ShopCX one-time-line carry is I/O-bound; covered by the live audit, see payment-recovery.md.)
 *
 * Run:
 *   npx tsx --test src/lib/recovery-migration-bugs.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isStructuralSubscribeAndSave } from "@/lib/coupons";
import { isRecentDunningCancel } from "@/lib/inngest/internal-dunning";

test("isStructuralSubscribeAndSave: matches the contract's S&S title variants", () => {
  for (const s of ["Subscribe & Save", "subscribe & save", "Subscribe and Save", "SUBSCRIBE&SAVE", "Subscribe & Save 25%"]) {
    assert.equal(isStructuralSubscribeAndSave(s), true, s);
  }
});

test("isStructuralSubscribeAndSave: real coupon codes are untouched", () => {
  for (const s of ["LOYALTY-15", "WELCOME-GSXN", "SAVE25", "SUBSCRIBESAVE", "Volume discount", "", null, undefined]) {
    assert.equal(isStructuralSubscribeAndSave(s as string | null | undefined), false, String(s));
  }
});

const NOW = new Date("2026-11-23T13:42:00Z");

test("isRecentDunningCancel: a dunning cancel days ago revives", () => {
  assert.equal(isRecentDunningCancel("2026-11-10T10:00:00Z", "2026-11-12T10:00:00Z", NOW), true);
  assert.equal(isRecentDunningCancel("2026-11-10T10:00:00Z", null, NOW), true);
});

test("isRecentDunningCancel: a stale April cycle on a sub voluntarily cancelled in August does NOT revive", () => {
  assert.equal(isRecentDunningCancel("2026-04-13T10:00:00Z", "2026-08-11T10:00:00Z", NOW), false);
});

test("isRecentDunningCancel: a cancel long after a recent cycle opened is a later voluntary cancel", () => {
  assert.equal(isRecentDunningCancel("2026-09-01T10:00:00Z", "2026-11-15T10:00:00Z", NOW), false);
});

test("isRecentDunningCancel: a historical cancelled_at from BEFORE the cycle is ignored", () => {
  assert.equal(isRecentDunningCancel("2026-11-01T10:00:00Z", "2025-06-01T10:00:00Z", NOW), true);
});

test("isRecentDunningCancel: missing cycle date never revives", () => {
  assert.equal(isRecentDunningCancel(null, null, NOW), false);
});
