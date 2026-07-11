/**
 * Pins `shouldBackstopRedispatch` — the pure decision for the lost-inbound-event safety net.
 * Re-dispatch ONLY when AI is on, the newest customer-facing message is an unanswered customer
 * message aged into [settle, maxAge], no reply is queued, and we haven't already backstopped it.
 *
 * Also pins the Phase-3 `shouldIntentReconcile` predicate + the `LOST_SEND_ALARM_THRESHOLD` /
 * `INTENT_SETTLE_MS` constants (the intent-based reconciler + drop-rate alarm).
 *
 * Run: npx tsx --test src/lib/inngest/unanswered-inbound-backstop-cron.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldBackstopRedispatch,
  shouldIntentReconcile,
  BACKSTOP_SETTLE_MS,
  BACKSTOP_MAX_AGE_MS,
  INTENT_SETTLE_MS,
  LOST_SEND_ALARM_THRESHOLD,
} from "./unanswered-inbound-backstop-cron";

const NOW = Date.parse("2026-07-11T12:00:00.000Z");
const base = {
  lastResponseAt: null as string | null,
  hasPendingSend: false,
  alreadyBackstopped: false,
  aiEnabled: true,
  now: NOW,
  settleMs: BACKSTOP_SETTLE_MS,
  maxAgeMs: BACKSTOP_MAX_AGE_MS,
};
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();

test("unanswered customer message past the settle window → re-dispatch (the c4889020 case)", () => {
  assert.equal(shouldBackstopRedispatch({ ...base, lastCustomerAt: agoMs(20 * 60 * 1000) }), true);
});

test("still inside the settle window → wait (don't race the handler)", () => {
  assert.equal(shouldBackstopRedispatch({ ...base, lastCustomerAt: agoMs(5 * 60 * 1000) }), false);
});

test("older than max age → stale, don't resurrect", () => {
  assert.equal(shouldBackstopRedispatch({ ...base, lastCustomerAt: agoMs(BACKSTOP_MAX_AGE_MS + 60_000) }), false);
});

test("a customer-facing response AFTER the customer message → answered, skip", () => {
  assert.equal(
    shouldBackstopRedispatch({ ...base, lastCustomerAt: agoMs(20 * 60 * 1000), lastResponseAt: agoMs(19 * 60 * 1000) }),
    false,
  );
});

test("a response BEFORE the customer's last message → still unanswered, re-dispatch", () => {
  assert.equal(
    shouldBackstopRedispatch({ ...base, lastCustomerAt: agoMs(20 * 60 * 1000), lastResponseAt: agoMs(40 * 60 * 1000) }),
    true,
  );
});

test("a reply already queued (pending send) → don't double-fire", () => {
  assert.equal(shouldBackstopRedispatch({ ...base, lastCustomerAt: agoMs(20 * 60 * 1000), hasPendingSend: true }), false);
});

test("already backstopped this message → idempotent skip", () => {
  assert.equal(shouldBackstopRedispatch({ ...base, lastCustomerAt: agoMs(20 * 60 * 1000), alreadyBackstopped: true }), false);
});

test("AI disabled for the channel → never re-fire", () => {
  assert.equal(shouldBackstopRedispatch({ ...base, lastCustomerAt: agoMs(20 * 60 * 1000), aiEnabled: false }), false);
});

test("no customer message at all → nothing to dispatch", () => {
  assert.equal(shouldBackstopRedispatch({ ...base, lastCustomerAt: null }), false);
});

// ── Phase 3 — intent-based reconcile predicate + drop-rate alarm ──

test("Phase 3 bullet — un-cleared dispatch_pending_at older than settle → re-dispatch (lost send)", () => {
  const staleStamp = new Date(NOW - INTENT_SETTLE_MS - 30_000).toISOString();
  assert.equal(
    shouldIntentReconcile({
      dispatchPendingAt: staleStamp,
      alreadyBackstopped: false,
      now: NOW,
      settleMs: INTENT_SETTLE_MS,
    }),
    true,
  );
});

test("Phase 3 bullet — handler-cleared intent (null) → skip (the pair's whole point)", () => {
  assert.equal(
    shouldIntentReconcile({
      dispatchPendingAt: null,
      alreadyBackstopped: false,
      now: NOW,
      settleMs: INTENT_SETTLE_MS,
    }),
    false,
  );
});

test("stamp inside the settle window → skip (don't race the handler)", () => {
  const freshStamp = new Date(NOW - 30_000).toISOString();
  assert.equal(
    shouldIntentReconcile({
      dispatchPendingAt: freshStamp,
      alreadyBackstopped: false,
      now: NOW,
      settleMs: INTENT_SETTLE_MS,
    }),
    false,
  );
});

test("intent-scan idempotency — a prior backstop marker → skip", () => {
  const staleStamp = new Date(NOW - INTENT_SETTLE_MS - 30_000).toISOString();
  assert.equal(
    shouldIntentReconcile({
      dispatchPendingAt: staleStamp,
      alreadyBackstopped: true,
      now: NOW,
      settleMs: INTENT_SETTLE_MS,
    }),
    false,
  );
});

test("malformed dispatch_pending_at → skip (defensive)", () => {
  assert.equal(
    shouldIntentReconcile({
      dispatchPendingAt: "not-a-date",
      alreadyBackstopped: false,
      now: NOW,
      settleMs: INTENT_SETTLE_MS,
    }),
    false,
  );
});

test("INTENT_SETTLE_MS is much tighter than BACKSTOP_SETTLE_MS (spec: 'much tighter')", () => {
  assert.ok(INTENT_SETTLE_MS < BACKSTOP_SETTLE_MS);
  assert.equal(INTENT_SETTLE_MS, 3 * 60 * 1000);
  assert.equal(BACKSTOP_SETTLE_MS, 12 * 60 * 1000);
});

test("LOST_SEND_ALARM_THRESHOLD is a small positive integer suitable for a 5-min sweep", () => {
  assert.ok(Number.isInteger(LOST_SEND_ALARM_THRESHOLD));
  assert.ok(LOST_SEND_ALARM_THRESHOLD >= 1 && LOST_SEND_ALARM_THRESHOLD <= 25);
});
