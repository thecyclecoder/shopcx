/**
 * Pins `shouldRouteToJune` — the 30-minute response SLA watchdog's pure decision. Route a
 * ticket to June ONLY when the newest inbound customer message has waited past
 * TICKET_RESPONSE_SLA_MS with no outbound external reply, no reply queued, and no prior
 * breach marker.
 *
 * Phase 1 of [[../specs/every-inbound-handled-within-30-min]].
 *
 * Run: npx tsx --test src/lib/inngest/ticket-response-sla-watchdog.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldRouteToJune,
  TICKET_RESPONSE_SLA_MS,
  SLA_MAX_AGE_MS,
} from "./ticket-response-sla-watchdog";

const NOW = Date.parse("2026-10-07T18:00:00.000Z");
const base = {
  lastResponseAt: null as string | null,
  hasPendingSend: false,
  alreadyMarked: false,
  now: NOW,
  slaMs: TICKET_RESPONSE_SLA_MS,
  maxAgeMs: SLA_MAX_AGE_MS,
};
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();

test("Angelica-shaped breach — 2h old inbound, no reply, nothing queued → route to June", () => {
  assert.equal(shouldRouteToJune({ ...base, lastCustomerAt: agoMs(2 * 60 * 60 * 1000) }), true);
});

test("still inside the SLA (10 min) → wait", () => {
  assert.equal(shouldRouteToJune({ ...base, lastCustomerAt: agoMs(10 * 60 * 1000) }), false);
});

test("exactly at the SLA (30 min) → route (boundary is inclusive on the breach side)", () => {
  assert.equal(shouldRouteToJune({ ...base, lastCustomerAt: agoMs(TICKET_RESPONSE_SLA_MS) }), true);
});

test("beyond the max age (24h+) → stale, do nothing", () => {
  assert.equal(
    shouldRouteToJune({ ...base, lastCustomerAt: agoMs(SLA_MAX_AGE_MS + 60 * 1000) }),
    false,
  );
});

test("outbound reply AT the customer time → already answered, don't route", () => {
  const t = agoMs(45 * 60 * 1000);
  assert.equal(shouldRouteToJune({ ...base, lastCustomerAt: t, lastResponseAt: t }), false);
});

test("outbound reply AFTER the customer time → already answered, don't route", () => {
  assert.equal(
    shouldRouteToJune({
      ...base,
      lastCustomerAt: agoMs(45 * 60 * 1000),
      lastResponseAt: agoMs(10 * 60 * 1000),
    }),
    false,
  );
});

test("outbound reply BEFORE the customer time (prior round-trip) → not an answer, route", () => {
  assert.equal(
    shouldRouteToJune({
      ...base,
      lastCustomerAt: agoMs(45 * 60 * 1000),
      lastResponseAt: agoMs(2 * 60 * 60 * 1000),
    }),
    true,
  );
});

test("a reply is queued (hasPendingSend) → wait, don't double-route", () => {
  assert.equal(
    shouldRouteToJune({
      ...base,
      lastCustomerAt: agoMs(45 * 60 * 1000),
      hasPendingSend: true,
    }),
    false,
  );
});

test("already marked (prior sweep breached + routed) → idempotent, skip", () => {
  assert.equal(
    shouldRouteToJune({
      ...base,
      lastCustomerAt: agoMs(45 * 60 * 1000),
      alreadyMarked: true,
    }),
    false,
  );
});

test("no customer message at all → nothing to breach", () => {
  assert.equal(shouldRouteToJune({ ...base, lastCustomerAt: null }), false);
});

test("constant pin — the SLA is 30 minutes", () => {
  assert.equal(TICKET_RESPONSE_SLA_MS, 30 * 60 * 1000);
});
