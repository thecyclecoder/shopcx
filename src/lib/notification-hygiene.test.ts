/**
 * Pins the notification-hygiene rules (CEO 2026-08-28).
 *
 * The wedge: `dashboard_notifications` held 2,237 undismissed rows against 13 real decisions — and
 * 98-100% of the pile was already READ. Nobody was ignoring it; dismissing just accomplishes nothing
 * when there is no decision, so anything informational accrues forever because a manual click is its
 * only exit.
 *
 * The dangerous failure mode for a sweep is the opposite one: retiring something that still needs
 * eyes. A live chargeback carries an `evidence_due_by` deadline, so these tests spend most of their
 * weight on what must NOT be swept.
 *
 * Run: npx tsx --test src/lib/notification-hygiene.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isExpiredReport,
  isChargebackSettled,
  DAILY_SUMMARY_TTL_DAYS,
  TERMINAL_CHARGEBACK_STATUSES,
} from "./notification-hygiene";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86400_000).toISOString();

// ── isExpiredReport ────────────────────────────────────────────────────────

test("a recap older than the TTL is retired", () => {
  assert.equal(isExpiredReport(daysAgo(8), NOW), true);
  // The real wedge: a standup from 2026-06-24 was still in an August inbox.
  assert.equal(isExpiredReport("2026-06-24T00:00:00Z", NOW), true);
});

test("a recent recap is kept — a weekend must not lose it", () => {
  assert.equal(isExpiredReport(daysAgo(1), NOW), false);
  assert.equal(isExpiredReport(daysAgo(6), NOW), false);
});

test("the boundary is exclusive: exactly TTL old is still kept", () => {
  assert.equal(isExpiredReport(daysAgo(DAILY_SUMMARY_TTL_DAYS), NOW), false);
  assert.equal(isExpiredReport(new Date(NOW - (DAILY_SUMMARY_TTL_DAYS * 86400_000 + 1000)).toISOString(), NOW), true);
});

test("⭐ an unparseable date is NEVER swept — a bad timestamp must not delete a notification", () => {
  for (const bad of ["", "not-a-date", "0000-13-45"]) {
    assert.equal(isExpiredReport(bad, NOW), false);
  }
});

test("a future-dated row is not expired", () => {
  assert.equal(isExpiredReport(daysAgo(-3), NOW), false);
});

// ── isChargebackSettled ────────────────────────────────────────────────────

test("won and lost are settled — the dispute is over", () => {
  assert.equal(isChargebackSettled({ status: "won" }), true);
  assert.equal(isChargebackSettled({ status: "lost" }), true);
});

test("⭐ under_review is NOT settled — this is the one that still wants eyes", () => {
  // 6 of the 60 ledger rows are under_review, and they carry an evidence_due_by deadline.
  // Sweeping these on age would hide a real deadline, which is the whole reason the sweep is
  // status-driven rather than a timer.
  assert.equal(isChargebackSettled({ status: "under_review" }), false);
});

test("a finalized_on stamp settles it even when the status has not caught up", () => {
  assert.equal(isChargebackSettled({ status: "under_review", finalized_on: "2026-08-07T05:35:07Z" }), true);
});

test("status matching is case-insensitive", () => {
  assert.equal(isChargebackSettled({ status: "LOST" }), true);
  assert.equal(isChargebackSettled({ status: "Won" }), true);
});

test("⭐ a MISSING ledger row is not settled — we never retire a pointer we cannot resolve", () => {
  // Guessing is what put a phantom card in the CEO inbox earlier the same day.
  assert.equal(isChargebackSettled(null), false);
  assert.equal(isChargebackSettled(undefined), false);
});

test("an unknown or empty status is not settled", () => {
  assert.equal(isChargebackSettled({ status: "needs_response" }), false);
  assert.equal(isChargebackSettled({ status: null }), false);
  assert.equal(isChargebackSettled({}), false);
});

test("the terminal set covers the statuses the live ledger actually uses", () => {
  // Observed 2026-08-28: {under_review: 6, lost: 29, won: 25}.
  assert.ok(TERMINAL_CHARGEBACK_STATUSES.has("won"));
  assert.ok(TERMINAL_CHARGEBACK_STATUSES.has("lost"));
  assert.ok(!TERMINAL_CHARGEBACK_STATUSES.has("under_review"));
});
