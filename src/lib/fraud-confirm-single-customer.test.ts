/**
 * Unit tests for the one-customer-at-a-time fraud-confirmation contract —
 * Phase 3 of fraud-bin-velocity-requires-real-cross-account-link.
 *
 * Ground truth: the bin:414740 case grouped a real fraudster (Patricia Ohara)
 * with 8 innocent customers who only shared her bank's card prefix. One
 * case-wide confirm cancelled ~17 subscriptions, refunded $1,017 and banned all
 * of them. The fix: confirming fraud acts on EXACTLY one named customer.
 *
 * These cover the pure boundary the confirm-fraud route + the fraud-status
 * readers share: the request validator (400s), the per-step customer scoping
 * (only A's subs/orders touched), the dedupe-append to confirmed_customer_ids,
 * and the reader predicate (B — not individually confirmed — is not blocked).
 *
 * Pure — no DB, no network. Run:
 *   npx tsx --test src/lib/fraud-confirm-single-customer.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateConfirmCustomerId,
  appendConfirmedCustomerId,
  isCustomerConfirmedFraud,
  filterToCustomer,
} from "./fraud-confirm";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const OUTSIDER = "99999999-9999-9999-9999-999999999999";
const CASE_CUSTOMERS = [A, B];

test("validate: a single customer_id that is a case member passes", () => {
  const r = validateConfirmCustomerId({ step: "ban_customer", customer_id: A }, CASE_CUSTOMERS);
  assert.deepEqual(r, { ok: true, customerId: A });
});

test("validate: missing customer_id → 400", () => {
  const r = validateConfirmCustomerId({ step: "ban_customer" }, CASE_CUSTOMERS);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 400);
});

test("validate: an array customer_id → 400", () => {
  const r = validateConfirmCustomerId({ step: "ban_customer", customer_id: [A, B] }, CASE_CUSTOMERS);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 400);
});

test("validate: a customer_ids (plural) body → 400 (legacy case-wide shape rejected)", () => {
  const r = validateConfirmCustomerId({ step: "ban_customer", customer_ids: [A, B] }, CASE_CUSTOMERS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.match(r.error, /customer_ids/);
  }
});

test("validate: a customer outside the case → 400", () => {
  const r = validateConfirmCustomerId({ step: "ban_customer", customer_id: OUTSIDER }, CASE_CUSTOMERS);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 400);
});

test("confirming A touches only A's subscriptions and orders — B's are untouched", () => {
  const subs = [
    { id: "s-a", customer_id: A },
    { id: "s-b", customer_id: B },
  ];
  const orders = [
    { id: "o-a1", customer_id: A },
    { id: "o-a2", customer_id: A },
    { id: "o-b", customer_id: B },
  ];
  assert.deepEqual(filterToCustomer(subs, A).map((s) => s.id), ["s-a"]);
  assert.deepEqual(filterToCustomer(orders, A).map((o) => o.id), ["o-a1", "o-a2"]);
  // B's records are never selected when confirming A.
  assert.equal(filterToCustomer(subs, A).some((s) => s.customer_id === B), false);
  assert.equal(filterToCustomer(orders, A).some((o) => o.customer_id === B), false);
});

test("append: confirming A records only A; confirming A again is idempotent; confirming B keeps A", () => {
  let confirmed: string[] = [];
  confirmed = appendConfirmedCustomerId(confirmed, A);
  assert.deepEqual(confirmed, [A]);
  confirmed = appendConfirmedCustomerId(confirmed, A); // idempotent
  assert.deepEqual(confirmed, [A]);
  confirmed = appendConfirmedCustomerId(confirmed, B); // second customer, independently
  assert.deepEqual(confirmed, [A, B]);
});

test("reader predicate: only individually-confirmed customers count as confirmed fraud", () => {
  // Case confirmed for A only. A is blocked; B — who merely shares the case
  // (same bank BIN) — is NOT blocked by getCustomerFraudStatus.
  const confirmed = [A];
  assert.equal(isCustomerConfirmedFraud(confirmed, [A]), true, "A is confirmed → blocked");
  assert.equal(isCustomerConfirmedFraud(confirmed, [B]), false, "B is NOT confirmed → not blocked");
  // Empty confirmed_customer_ids never blocks anyone.
  assert.equal(isCustomerConfirmedFraud([], [A]), false);
  assert.equal(isCustomerConfirmedFraud(null, [A]), false);
  // Overlap across a customer's linked ids still counts.
  assert.equal(isCustomerConfirmedFraud(confirmed, [B, A]), true);
});
