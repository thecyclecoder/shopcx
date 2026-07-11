/**
 * Pins `shouldBackstopRedispatch` — the pure decision for the lost-inbound-event safety net.
 * Re-dispatch ONLY when AI is on, the newest customer-facing message is an unanswered customer
 * message aged into [settle, maxAge], no reply is queued, and we haven't already backstopped it.
 *
 * Run: npx tsx --test src/lib/inngest/unanswered-inbound-backstop-cron.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldBackstopRedispatch,
  BACKSTOP_SETTLE_MS,
  BACKSTOP_MAX_AGE_MS,
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
