/**
 * Unit tests for commerce/refund.issueRefund
 * (Phase 2 of docs/brain/specs/commerce-sdk-actions-create-order-create-subscription-refund-and-dollar-replacement.md).
 *
 * The SDK wrapper is a thin facade over `refund.refundOrder` — the low-level
 * gateway-aware dispatcher. These tests pin the CONTRACT the wrapper commits
 * to at the SDK boundary, which is the invariant the compiler-loop callers
 * + `directActionHandlers.partial_refund` / `.redeem_points_as_refund`
 * depend on:
 *
 *   1. args shape → refundOrder call-shape mapping (positional →
 *      RefundOrderOptions).
 *   2. Boundary preconditions (empty workspaceId / orderId → early error, no
 *      delegate call).
 *   3. Result shape passes through verbatim (method, refund_id, error,
 *      needsManualShopifyRecord, dryRun).
 *
 * The delegate itself hits Supabase + Braintree/Shopify, which we don't
 * want to spin up in unit-test land. We stub `@/lib/refund.refundOrder` via
 * a module-level `refundOrderStub` swap — `commerce/refund.ts` dynamic-
 * imports the delegate, so overwriting the module cache entry works.
 *
 * Run:
 *   npm run test:commerce-refund
 *   (= tsx --test src/lib/commerce/refund.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import { issueRefund } from "./refund";
import type { RefundOrderOptions, RefundOrderResult } from "@/lib/refund";

// ── Stub the delegate ─────────────────────────────────────────────
// `commerce/refund.ts` does `await import("@/lib/refund")`. tsx maps
// `@/lib/refund` to `src/lib/refund.ts` at load time. We hook Node's
// module cache so the dynamic import returns our stub with a spy on
// `refundOrder`. Restored per test via `withStub`.

type Call = {
  workspaceId: string;
  orderId: string;
  amountCents: number;
  reason: string;
  opts: RefundOrderOptions;
};

let calls: Call[] = [];
let nextResult: RefundOrderResult = { success: true };

const stubRefundOrder = async (
  workspaceId: string,
  orderId: string,
  amountCents: number,
  reason: string,
  opts: RefundOrderOptions = {},
): Promise<RefundOrderResult> => {
  calls.push({ workspaceId, orderId, amountCents, reason, opts });
  return nextResult;
};

// Node's ESM cache lets us intercept the dynamic import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
const REFUND_KEY_CANDIDATES = [
  require.resolve("@/lib/refund"),
];
for (const key of REFUND_KEY_CANDIDATES) {
  moduleAny._cache[key] = { exports: { refundOrder: stubRefundOrder } };
}

function resetStub(): void {
  calls = [];
  nextResult = { success: true };
}

// ── Boundary preconditions ────────────────────────────────────────

test("issueRefund: empty workspaceId → early error, delegate NOT called", async () => {
  resetStub();
  const r = await issueRefund("", { orderId: "ord-1", amountCents: 100, reason: "x" });
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /workspaceId is required/);
  assert.equal(calls.length, 0);
});

test("issueRefund: empty orderId → early error, delegate NOT called", async () => {
  resetStub();
  const r = await issueRefund("ws-1", { orderId: "", amountCents: 100, reason: "x" });
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /orderId is required/);
  assert.equal(calls.length, 0);
});

// ── Delegate call shape ──────────────────────────────────────────

test("issueRefund: forwards orderId, amountCents, reason to refundOrder as positional args", async () => {
  resetStub();
  await issueRefund("ws-1", {
    orderId: "ord-abc",
    amountCents: 750,
    reason: "customer overcharged",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspaceId, "ws-1");
  assert.equal(calls[0].orderId, "ord-abc");
  assert.equal(calls[0].amountCents, 750);
  assert.equal(calls[0].reason, "customer overcharged");
});

test("issueRefund: forwards source, customerId, eventProperties into RefundOrderOptions", async () => {
  resetStub();
  await issueRefund("ws-1", {
    orderId: "ord-abc",
    amountCents: 500,
    reason: "loyalty",
    source: "ai",
    customerId: "cust-1",
    eventProperties: { ticket_id: "t-9", loyalty_tier: "silver" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.source, "ai");
  assert.equal(calls[0].opts.customerId, "cust-1");
  assert.deepEqual(calls[0].opts.eventProperties, { ticket_id: "t-9", loyalty_tier: "silver" });
});

test("issueRefund: dryRun=true passes through into RefundOrderOptions", async () => {
  resetStub();
  await issueRefund("ws-1", {
    orderId: "ord-abc",
    amountCents: 0,
    reason: "probe",
    dryRun: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.dryRun, true);
});

// ── Result shape pass-through ────────────────────────────────────

test("issueRefund: propagates delegate success + method + refund_id", async () => {
  resetStub();
  nextResult = { success: true, method: "braintree", refund_id: "bt-abc" };
  const r = await issueRefund("ws-1", { orderId: "ord-1", amountCents: 100, reason: "x" });
  assert.equal(r.success, true);
  assert.equal(r.method, "braintree");
  assert.equal(r.refund_id, "bt-abc");
});

test("issueRefund: propagates delegate error verbatim", async () => {
  resetStub();
  nextResult = { success: false, error: "Braintree refund failed: card declined" };
  const r = await issueRefund("ws-1", { orderId: "ord-1", amountCents: 100, reason: "x" });
  assert.equal(r.success, false);
  assert.equal(r.error, "Braintree refund failed: card declined");
});

test("issueRefund: propagates needsManualShopifyRecord flag", async () => {
  resetStub();
  nextResult = { success: true, method: "braintree", refund_id: "bt-2", needsManualShopifyRecord: true };
  const r = await issueRefund("ws-1", { orderId: "ord-1", amountCents: 100, reason: "x" });
  assert.equal(r.success, true);
  assert.equal(r.needsManualShopifyRecord, true);
});

test("issueRefund: propagates dryRun flag on the result", async () => {
  resetStub();
  nextResult = { success: true, method: "shopify", dryRun: true };
  const r = await issueRefund("ws-1", { orderId: "ord-1", amountCents: 0, reason: "probe", dryRun: true });
  assert.equal(r.success, true);
  assert.equal(r.method, "shopify");
  assert.equal(r.dryRun, true);
});
