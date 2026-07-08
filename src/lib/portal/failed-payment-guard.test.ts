/**
 * Unit tests for shouldBlockForFailedPayment — the pure predicate the
 * portal change-date + frequency handlers use to decide whether to reject
 * with payment_failed_update_blocked.
 *
 * Focus: the concrete failing state from ticket 115350d5 — internal sub
 * e1d4f32b was blocked because the guard checked last_payment_status
 * WITHOUT checking is_internal, even though the mutation would succeed
 * (and did, when tested live). Run:
 *   npx tsx --test src/lib/portal/failed-payment-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldBlockForFailedPayment } from "./failed-payment-guard";

test("internal sub with last_payment_status='failed' → NOT blocked (Phase 1 fix, ticket 115350d5)", () => {
  assert.equal(
    shouldBlockForFailedPayment({ is_internal: true, last_payment_status: "failed" }),
    false,
  );
});

test("Appstle sub (is_internal=false) with last_payment_status='failed' → blocked (behavior preserved)", () => {
  assert.equal(
    shouldBlockForFailedPayment({ is_internal: false, last_payment_status: "failed" }),
    true,
  );
});

test("Appstle sub with successful last payment → NOT blocked", () => {
  assert.equal(
    shouldBlockForFailedPayment({ is_internal: false, last_payment_status: "success" }),
    false,
  );
});

test("Appstle sub with null last_payment_status → NOT blocked (unknown ≠ failed)", () => {
  assert.equal(
    shouldBlockForFailedPayment({ is_internal: false, last_payment_status: null }),
    false,
  );
});

test("internal sub with successful last payment → NOT blocked", () => {
  assert.equal(
    shouldBlockForFailedPayment({ is_internal: true, last_payment_status: "success" }),
    false,
  );
});
