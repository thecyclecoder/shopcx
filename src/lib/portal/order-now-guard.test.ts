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
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  guardAppstleOrderNow,
  guardInternalOrderNow,
  pickInternalOrderNowBlock,
  INTERNAL_ORDER_NOW_RECENT_WINDOW_MS,
  type InternalOrderNowLedgerRow,
} from "./order-now-guard";

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

// ─── Phase 1 — guardInternalOrderNow pure predicate ─────────────────────
// docs/brain/specs/a-subscription-is-never-more-than-one-cycle-behind.md
// Ground truth: 2026-09-23 portal.order_now presses at 01:08:28 / 01:09:40 / 01:19:49
// on the same subscription produced three charges 5s behind each press. Press #2 fires
// while press #1's claim is still in_flight; press #3 fires 10min after press #2 with
// the ledger row already succeeded but well within the 15-minute recent window.

test("no ledger rows → proceed (first legitimate press)", () => {
  assert.equal(pickInternalOrderNowBlock([], Date.now(), INTERNAL_ORDER_NOW_RECENT_WINDOW_MS), null);
});

test("in_flight row → block:in_flight (press #2 while press #1 is still charging)", () => {
  const NOW = 1_800_000_000_000;
  const rows: InternalOrderNowLedgerRow[] = [
    { status: "in_flight", claimed_at: new Date(NOW - 3_000).toISOString() },
  ];
  const blocker = pickInternalOrderNowBlock(rows, NOW, INTERNAL_ORDER_NOW_RECENT_WINDOW_MS);
  assert.ok(blocker);
  assert.equal(blocker?.reason, "in_flight");
});

test("stale in_flight also blocks — regardless of age, an unresolved claim is a live charge", () => {
  const NOW = 1_800_000_000_000;
  const rows: InternalOrderNowLedgerRow[] = [
    // 2h old but still in_flight — a wedged claim (see Control Tower renewal-wedged-cycles).
    // Refusing here is correct: a subsequent portal press must not race a stranded in_flight
    // that might yet resolve one way or another.
    { status: "in_flight", claimed_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
  ];
  const blocker = pickInternalOrderNowBlock(rows, NOW, INTERNAL_ORDER_NOW_RECENT_WINDOW_MS);
  assert.equal(blocker?.reason, "in_flight");
});

test("succeeded 10 min ago → block:recent_charge (press #3 in the ground-truth burst)", () => {
  // Press #2's charge landed at 01:09:45; press #3 fires at 01:19:49 = 10min 04s later.
  // A 15-minute window catches it as a double-press.
  const NOW = 1_800_000_000_000;
  const rows: InternalOrderNowLedgerRow[] = [
    { status: "succeeded", claimed_at: new Date(NOW - (10 * 60 + 4) * 1000).toISOString() },
  ];
  const blocker = pickInternalOrderNowBlock(rows, NOW, INTERNAL_ORDER_NOW_RECENT_WINDOW_MS);
  assert.equal(blocker?.reason, "recent_charge");
});

test("failed charge inside the window → block:recent_charge (still-broken card, not a retry surface)", () => {
  const NOW = 1_800_000_000_000;
  const rows: InternalOrderNowLedgerRow[] = [
    { status: "failed", claimed_at: new Date(NOW - 60_000).toISOString() },
  ];
  const blocker = pickInternalOrderNowBlock(rows, NOW, INTERNAL_ORDER_NOW_RECENT_WINDOW_MS);
  assert.equal(blocker?.reason, "recent_charge");
});

test("succeeded outside the window → proceed (genuine deliberate second order)", () => {
  const NOW = 1_800_000_000_000;
  const rows: InternalOrderNowLedgerRow[] = [
    // 20 min after the last charge landed — well past the 15-min window. A press this
    // late is treated as a deliberate second order, not a double-press.
    { status: "succeeded", claimed_at: new Date(NOW - 20 * 60 * 1000).toISOString() },
  ];
  assert.equal(
    pickInternalOrderNowBlock(rows, NOW, INTERNAL_ORDER_NOW_RECENT_WINDOW_MS),
    null,
  );
});

test("unparseable claimed_at is not treated as recent — skipped, does not falsely block", () => {
  const NOW = 1_800_000_000_000;
  const rows: InternalOrderNowLedgerRow[] = [
    { status: "succeeded", claimed_at: "not-a-date" },
  ];
  assert.equal(
    pickInternalOrderNowBlock(rows, NOW, INTERNAL_ORDER_NOW_RECENT_WINDOW_MS),
    null,
  );
});

test("guardInternalOrderNow — no rows → proceed", async () => {
  const admin = fakeAdmin([]);
  const verdict = await guardInternalOrderNow(admin, {
    subscription_id: "sub-abc",
    now: 1_800_000_000_000,
  });
  assert.deepEqual(verdict, { action: "proceed" });
});

test("guardInternalOrderNow — in_flight row → block with rendered message", async () => {
  const NOW = 1_800_000_000_000;
  const admin = fakeAdmin([
    { status: "in_flight", claimed_at: new Date(NOW - 3_000).toISOString() },
  ]);
  const verdict = await guardInternalOrderNow(admin, {
    subscription_id: "sub-abc",
    now: NOW,
  });
  assert.equal(verdict.action, "block");
  if (verdict.action !== "block") return;
  assert.equal(verdict.reason, "order_in_progress");
  assert.equal(verdict.message, "Your order is already being placed.");
});

test("guardInternalOrderNow — DB error propagates (never silently proceed)", async () => {
  const admin = fakeAdmin([], { message: "connection refused" });
  await assert.rejects(
    () =>
      guardInternalOrderNow(admin, { subscription_id: "sub-abc", now: 1_800_000_000_000 }),
    /guard_internal_order_now_read_failed/,
  );
});

// Minimal PostgREST-shaped stub for the guard's DB reads: the guard only exercises
// admin.from(...).select(...).eq(...).or(...).order(...).limit(...) → Promise<{data,error}>.
// The full PostgREST builder is far larger than we need for a unit test; the guard body
// only touches these five chained calls, so we structurally satisfy that subset and cast
// to `SupabaseClient` at the call site.
function fakeAdmin(
  rows: InternalOrderNowLedgerRow[],
  error: { message: string } | null = null,
): SupabaseClient {
  const terminal = {
    limit: async (_n: number) => ({
      data: error ? null : rows,
      error,
    }),
  };
  const stub = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          or: (_expr: string) => ({
            order: (_orderCol: string, _opts: { ascending: boolean }) => terminal,
          }),
        }),
      }),
    }),
  };
  return stub as unknown as SupabaseClient;
}
