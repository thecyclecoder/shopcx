/**
 * Pins the cancel-truth invariant: a cancel-shaped subscription update always
 * clears next_billing_date and stamps cancelled_at; a pause/resume update
 * leaves the billing date alone.
 *
 * The 2026-08-21 f773b8ec case is the reason — a cancelled row that still
 * advertised a future charge date made the CS Director misreport billing
 * history to the founder. Both writers (webhook + direct SDK) call
 * applyCancelTruth, so this is the shared regression seam.
 *
 * Run: npx tsx --test src/lib/subscription-cancel-truth.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyCancelTruth, buildCancelTruthPatch, isCancelAction } from "./subscription-cancel-truth";

test("a cancel yields next_billing_date=null and a non-null cancelled_at", () => {
  const update: Record<string, unknown> = {
    status: "cancelled",
    updated_at: "2026-08-21T10:00:00.000Z",
    next_billing_date: "2026-09-11",
  };
  applyCancelTruth(update, "cancel", { nowIso: "2026-08-21T10:00:00.000Z" });
  assert.equal(update.next_billing_date, null, "cancelled row cannot advertise a future charge");
  assert.equal(update.cancelled_at, "2026-08-21T10:00:00.000Z", "cancelled_at must be stamped on the same write");
});

test("a mapped 'cancelled' status (webhook mapStatus result) is treated the same as 'cancel'", () => {
  const update: Record<string, unknown> = { status: "cancelled", next_billing_date: "2026-09-11" };
  applyCancelTruth(update, "cancelled", { nowIso: "2026-08-21T10:00:00.000Z" });
  assert.equal(update.next_billing_date, null);
  assert.equal(update.cancelled_at, "2026-08-21T10:00:00.000Z");
});

test("a pause update leaves next_billing_date alone and never stamps cancelled_at", () => {
  const update: Record<string, unknown> = {
    status: "paused",
    next_billing_date: "2026-09-11",
  };
  applyCancelTruth(update, "pause");
  assert.equal(update.next_billing_date, "2026-09-11", "pause must preserve the billing date");
  assert.equal(update.cancelled_at, undefined, "cancelled_at must not be stamped on pause");
});

test("a resume update leaves next_billing_date alone and never stamps cancelled_at", () => {
  const update: Record<string, unknown> = {
    status: "active",
    next_billing_date: "2026-09-11",
  };
  applyCancelTruth(update, "resume");
  assert.equal(update.next_billing_date, "2026-09-11");
  assert.equal(update.cancelled_at, undefined);
});

test("cancelled_at is preserved across repeat webhooks (Appstle re-sends the same cancel event)", () => {
  const update: Record<string, unknown> = { status: "cancelled" };
  applyCancelTruth(update, "cancelled", {
    existingCancelledAt: "2026-07-17T08:39:51.000Z",
    nowIso: "2026-08-21T10:00:00.000Z",
  });
  assert.equal(
    update.cancelled_at,
    "2026-07-17T08:39:51.000Z",
    "an existing cancelled_at is the historical record; a repeat webhook must not overwrite it",
  );
  assert.equal(update.next_billing_date, null);
});

test("buildCancelTruthPatch returns an empty patch for non-cancel actions", () => {
  assert.deepEqual(buildCancelTruthPatch("pause"), {});
  assert.deepEqual(buildCancelTruthPatch("resume"), {});
  assert.deepEqual(buildCancelTruthPatch("active"), {});
  assert.deepEqual(buildCancelTruthPatch("paused"), {});
});

test("isCancelAction matches both the SDK action verb and the row-status noun", () => {
  assert.equal(isCancelAction("cancel"), true);
  assert.equal(isCancelAction("cancelled"), true);
  assert.equal(isCancelAction("pause"), false);
  assert.equal(isCancelAction("resume"), false);
  assert.equal(isCancelAction("active"), false);
});
