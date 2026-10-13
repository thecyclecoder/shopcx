/** pickCancelledAt — the backfill only ever writes an EVIDENCED cancellation date. */
import test from "node:test";
import assert from "node:assert/strict";
import { pickCancelledAt } from "./_backfill-internal-cancelled-at";

const none = { cancelEventAt: null, migratedAsCancelledAt: null, appstleCancelEventAt: null };

test("a cancel event for this sub wins", () => {
  assert.deepEqual(pickCancelledAt({ ...none, cancelEventAt: "2026-09-10T09:01:00Z" }), { at: "2026-09-10T09:01:00Z", source: "cancel_event" });
});

test("migrated already-cancelled + an Appstle cancel webhook before the migration → that date", () => {
  assert.deepEqual(
    pickCancelledAt({ ...none, migratedAsCancelledAt: "2026-07-09T01:58:00Z", appstleCancelEventAt: "2026-03-25T01:18:00Z" }),
    { at: "2026-03-25T01:18:00Z", source: "appstle_cancel_webhook" },
  );
});

test("an Appstle cancel webhook AFTER the migration is not trusted", () => {
  assert.equal(pickCancelledAt({ ...none, migratedAsCancelledAt: "2026-07-09T01:58:00Z", appstleCancelEventAt: "2026-08-31T16:56:16Z" }), null);
});

test("Appstle webhook but the sub was NOT migrated as cancelled → no date", () => {
  assert.equal(pickCancelledAt({ ...none, appstleCancelEventAt: "2026-03-25T01:18:00Z" }), null);
});

test("no evidence at all / unparseable dates → null (never invented)", () => {
  assert.equal(pickCancelledAt(none), null);
  assert.equal(pickCancelledAt({ ...none, cancelEventAt: "nope" }), null);
  assert.equal(pickCancelledAt({ ...none, migratedAsCancelledAt: "2026-07-09T01:58:00Z", appstleCancelEventAt: "nope" }), null);
});
