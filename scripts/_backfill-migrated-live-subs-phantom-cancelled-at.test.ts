/**
 * The backfill's eligibility predicate: only a `cancelled_at` the migration itself wrote (in the
 * seconds BEFORE its own audit row) is cleared — never a real cancel that happened later.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isMigrationStampedCancelledAt, WINDOW_MS } from "./_backfill-migrated-live-subs-phantom-cancelled-at";

const audit = "2026-09-20T14:56:25.500Z";

test("stamp seconds before its migration audit → migration-stamped (cleared)", () => {
  assert.equal(isMigrationStampedCancelledAt("2026-09-20T14:56:24.000Z", [audit]), true);
});

test("stamp equal to the audit time → migration-stamped", () => {
  assert.equal(isMigrationStampedCancelledAt(audit, [audit]), true);
});

test("stamp AFTER the migration (a real later cancel, then reactivated) → left alone", () => {
  assert.equal(isMigrationStampedCancelledAt("2026-09-21T10:00:00.000Z", [audit]), false);
});

test("stamp long before the migration (an old cancel) → left alone", () => {
  assert.equal(isMigrationStampedCancelledAt("2026-07-01T00:00:00.000Z", [audit]), false);
  const justOutside = new Date(new Date(audit).getTime() - WINDOW_MS - 1).toISOString();
  assert.equal(isMigrationStampedCancelledAt(justOutside, [audit]), false);
});

test("no audit row, null or unparseable stamp → left alone", () => {
  assert.equal(isMigrationStampedCancelledAt("2026-09-20T14:56:24.000Z", []), false);
  assert.equal(isMigrationStampedCancelledAt(null, [audit]), false);
  assert.equal(isMigrationStampedCancelledAt("nope", [audit]), false);
});

test("any one of several audits can anchor it", () => {
  assert.equal(
    isMigrationStampedCancelledAt("2026-09-20T14:56:24.000Z", ["2026-06-01T00:00:00.000Z", audit]),
    true,
  );
});
