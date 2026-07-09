/**
 * Unit tests for guardAppstleOrderNow — the pure predicate the portal
 * order-now handler + dashboard bill-now route use to decide whether firing
 * `appstleAttemptBilling` is safe.
 *
 * Focus: the concrete failing state from ticket 183d28b9 — Ellyn's portal
 * 'order now' targeted a cancelled/migrated Appstle contract (27803779245)
 * and Appstle returned "All 1 products in this subscription are currently
 * out of stock", a stale-contract artifact of the migration. The gate here
 * must return `block:contract_cancelled` for that shape so the caller
 * short-circuits with a clear non-OOS message.
 *
 *   npx tsx --test src/lib/portal/order-now-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { guardAppstleOrderNow } from "./order-now-guard";

test("cancelled Appstle sub → block:contract_cancelled (ticket 183d28b9 — Ellyn/27803779245)", () => {
  const verdict = guardAppstleOrderNow({ is_internal: false, status: "cancelled" });
  assert.equal(verdict.action, "block");
  if (verdict.action !== "block") return;
  assert.equal(verdict.reason, "contract_cancelled");
  assert.equal(verdict.message, "This subscription is no longer active.");
});

test("paused Appstle sub → block:contract_not_active", () => {
  const verdict = guardAppstleOrderNow({ is_internal: false, status: "paused" });
  assert.equal(verdict.action, "block");
  if (verdict.action !== "block") return;
  assert.equal(verdict.reason, "contract_not_active");
});

test("active Appstle sub → proceed", () => {
  assert.deepEqual(
    guardAppstleOrderNow({ is_internal: false, status: "active" }),
    { action: "proceed" },
  );
});

test("internal sub always proceeds — the Appstle gate is not its concern", () => {
  assert.deepEqual(
    guardAppstleOrderNow({ is_internal: true, status: "active" }),
    { action: "proceed" },
  );
  assert.deepEqual(
    guardAppstleOrderNow({ is_internal: true, status: "cancelled" }),
    { action: "proceed" },
  );
});

test("null status on an Appstle sub → proceed (unknown ≠ cancelled)", () => {
  assert.deepEqual(
    guardAppstleOrderNow({ is_internal: false, status: null }),
    { action: "proceed" },
  );
});
