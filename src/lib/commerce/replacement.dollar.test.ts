/**
 * Unit tests for commerce/replacement.issueDollarReplacement
 * (Phase 3 of docs/brain/specs/commerce-sdk-actions-create-order-create-subscription-refund-and-dollar-replacement.md).
 *
 * Pins the ATOMICITY contract — the invariant every caller depends on:
 * a failed money half rolls back the just-created replacements row so no
 * orphan record survives. The tests drive `issueDollarReplacement` with
 * fully stubbed delegates (issueReplacement / issueRefund /
 * subscriptionOrderNow / rollbackReplacement / writeOrderRefundMirror)
 * so the harness is deterministic and doesn't need Supabase + Shopify +
 * Braintree.
 *
 * Run:
 *   npm run test:commerce-replacement-dollar
 *   (= tsx --test src/lib/commerce/replacement.dollar.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  issueDollarReplacement,
  type DollarReplacementDeps,
  type DollarReplacementArgs,
} from "./replacement";

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const CUSTOMER = "22222222-2222-2222-2222-222222222222";
const REPLACEMENT_ID = "rep-9999";
const REFUND_ORDER_ID = "ord-refund-1";

function makeArgs(overrides: Partial<DollarReplacementArgs> = {}): DollarReplacementArgs {
  return {
    customerId: CUSTOMER,
    shopifyCustomerId: "shop-cust-1",
    items: [{ variantId: "v-1", quantity: 1 }],
    shippingAddress: {
      address1: "1 Main",
      city: "Austin",
      provinceCode: "TX",
      zip: "78701",
      countryCode: "US",
    },
    reason: "damaged_items",
    initiatedBy: "ai",
    refund: {
      orderId: REFUND_ORDER_ID,
      amountCents: 1000,
      reason: "damaged_items",
    },
    ...overrides,
  };
}

/** Build the stub-deps set with success by default; each test overrides
 *  the delegate it's exercising. Also collects the call log so the tests
 *  can assert order / count / never-called invariants. */
function makeDeps(overrides: Partial<DollarReplacementDeps> = {}): {
  deps: DollarReplacementDeps;
  calls: {
    replacement: Array<{ workspaceId: string; args: unknown }>;
    refund: Array<{ workspaceId: string; args: unknown }>;
    orderNow: Array<{ workspaceId: string; contractId: string }>;
    rollback: Array<{ workspaceId: string; replacementId: string }>;
    mirror: Array<{ workspaceId: string; mirror: unknown }>;
  };
} {
  const calls = {
    replacement: [] as Array<{ workspaceId: string; args: unknown }>,
    refund: [] as Array<{ workspaceId: string; args: unknown }>,
    orderNow: [] as Array<{ workspaceId: string; contractId: string }>,
    rollback: [] as Array<{ workspaceId: string; replacementId: string }>,
    mirror: [] as Array<{ workspaceId: string; mirror: unknown }>,
  };
  const deps: DollarReplacementDeps = {
    issueReplacement: async (workspaceId, args) => {
      calls.replacement.push({ workspaceId, args });
      return { success: true, replacementId: REPLACEMENT_ID, shopifyOrderName: "SC900000" };
    },
    issueRefund: async (workspaceId, args) => {
      calls.refund.push({ workspaceId, args });
      return { success: true, method: "shopify", refund_id: "bt-1" };
    },
    subscriptionOrderNow: async (workspaceId, contractId) => {
      calls.orderNow.push({ workspaceId, contractId });
      return { success: true };
    },
    rollbackReplacement: async (workspaceId, replacementId) => {
      calls.rollback.push({ workspaceId, replacementId });
      return { deleted: true };
    },
    writeOrderRefundMirror: async (workspaceId, mirror) => {
      calls.mirror.push({ workspaceId, mirror });
      return { inserted: true };
    },
    ...overrides,
  };
  return { deps, calls };
}

// ── Boundary preconditions ────────────────────────────────────────

test("issueDollarReplacement: empty workspaceId → early error, no delegate called", async () => {
  const { deps, calls } = makeDeps();
  const r = await issueDollarReplacement("", makeArgs(), deps);
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /workspaceId is required/);
  assert.equal(calls.replacement.length, 0);
});

test("issueDollarReplacement: passing both refund + upcharge → error, no delegate called", async () => {
  const { deps, calls } = makeDeps();
  const r = await issueDollarReplacement(WORKSPACE, makeArgs({
    upcharge: { contractId: "c-1" },
  }), deps);
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /pass `refund` OR `upcharge`, not both/);
  assert.equal(calls.replacement.length, 0);
});

test("issueDollarReplacement: neither refund nor upcharge → error (bare replacements use issueReplacement)", async () => {
  const { deps, calls } = makeDeps();
  const r = await issueDollarReplacement(WORKSPACE, makeArgs({ refund: undefined }), deps);
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /one of `refund` \/ `upcharge` is required/);
  assert.equal(calls.replacement.length, 0);
});

// ── Happy path (refund flavor) — replacement + refund + mirror ────

test("issueDollarReplacement (refund): success → replacement + refund + order_refunds mirror all fire (spec verification bullet 1)", async () => {
  const { deps, calls } = makeDeps();
  const r = await issueDollarReplacement(WORKSPACE, makeArgs(), deps);
  assert.equal(r.success, true);
  assert.equal(r.replacementId, REPLACEMENT_ID);
  assert.equal(r.orderRefundsMirrored, true);
  assert.equal(calls.replacement.length, 1);
  assert.equal(calls.refund.length, 1);
  assert.equal(calls.mirror.length, 1);
  assert.equal(calls.rollback.length, 0);
});

test("issueDollarReplacement (refund): mirror row carries amount_cents=1000 (spec verification bullet 1)", async () => {
  const { deps, calls } = makeDeps();
  await issueDollarReplacement(WORKSPACE, makeArgs(), deps);
  const mirror = calls.mirror[0].mirror as { amount_cents: number; order_id: string; replacement_id: string };
  assert.equal(mirror.amount_cents, 1000);
  assert.equal(mirror.order_id, REFUND_ORDER_ID);
  assert.equal(mirror.replacement_id, REPLACEMENT_ID);
});

test("issueDollarReplacement (refund): refund half receives replacement_id in eventProperties (audit link)", async () => {
  const { deps, calls } = makeDeps();
  await issueDollarReplacement(WORKSPACE, makeArgs(), deps);
  const refundArgs = calls.refund[0].args as { eventProperties: { replacement_id: string } };
  assert.equal(refundArgs.eventProperties.replacement_id, REPLACEMENT_ID);
});

// ── ATOMICITY (refund half fails) — spec verification bullet 2 ────

test("issueDollarReplacement (refund): refund fails → rollback fires, no orphan replacement (spec verification bullet 2)", async () => {
  const { deps, calls } = makeDeps();
  // Override AFTER makeDeps so we retain the call-logging wrapper.
  const inner = deps.issueRefund;
  deps.issueRefund = async (ws, a) => {
    await inner(ws, a); // preserve the call log
    return { success: false, error: "Braintree declined" };
  };
  const r = await issueDollarReplacement(WORKSPACE, makeArgs(), deps);
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /Refund failed after replacement created/);
  assert.equal(r.rolledBack, true);
  assert.equal(calls.replacement.length, 1, "replacement WAS created (record-first)");
  assert.equal(calls.refund.length, 1, "refund attempt fired");
  assert.equal(calls.rollback.length, 1, "rollback fired");
  assert.equal(calls.mirror.length, 0, "mirror NOT written on refund failure");
  assert.equal(calls.rollback[0].workspaceId, WORKSPACE);
  assert.equal(calls.rollback[0].replacementId, REPLACEMENT_ID);
});

test("issueDollarReplacement (refund): rollback deleted=false surfaces on the result (row already gone / race)", async () => {
  const { deps } = makeDeps();
  deps.issueRefund = async () => ({ success: false, error: "Braintree declined" });
  deps.rollbackReplacement = async () => ({ deleted: false });
  const r = await issueDollarReplacement(WORKSPACE, makeArgs(), deps);
  assert.equal(r.success, false);
  assert.equal(r.rolledBack, false);
});

// ── Replacement half fails first — refund never fires ────────────

test("issueDollarReplacement (refund): replacement fails → refund never fires, no rollback (nothing to compensate)", async () => {
  const { deps, calls } = makeDeps();
  deps.issueReplacement = async () => ({ success: false, replacementId: "", shopifyOrderName: null, error: "Shopify draft failed" });
  const r = await issueDollarReplacement(WORKSPACE, makeArgs(), deps);
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /Replacement failed/);
  assert.equal(calls.refund.length, 0);
  assert.equal(calls.rollback.length, 0);
  assert.equal(calls.mirror.length, 0);
});

// ── Mirror write soft-fails — refund success still stands ────────

test("issueDollarReplacement (refund): order_refunds mirror soft-fail does NOT roll back (refund already moved money)", async () => {
  const { deps, calls } = makeDeps();
  const innerMirror = deps.writeOrderRefundMirror;
  deps.writeOrderRefundMirror = async (ws, m) => {
    await innerMirror(ws, m);
    return { inserted: false };
  };
  const r = await issueDollarReplacement(WORKSPACE, makeArgs(), deps);
  assert.equal(r.success, true);
  assert.equal(r.orderRefundsMirrored, false);
  assert.equal(calls.rollback.length, 0, "mirror miss must NEVER trigger a rollback");
});

// ── Upcharge flavor ──────────────────────────────────────────────

test("issueDollarReplacement (upcharge): success → replacement + subscriptionOrderNow fire, no refund/mirror path", async () => {
  const { deps, calls } = makeDeps();
  const r = await issueDollarReplacement(WORKSPACE, makeArgs({
    refund: undefined,
    upcharge: { contractId: "contract-abc" },
  }), deps);
  assert.equal(r.success, true);
  assert.equal(calls.replacement.length, 1);
  assert.equal(calls.orderNow.length, 1);
  assert.equal(calls.orderNow[0].contractId, "contract-abc");
  assert.equal(calls.refund.length, 0);
  assert.equal(calls.mirror.length, 0);
  assert.equal(calls.rollback.length, 0);
});

test("issueDollarReplacement (upcharge): subscriptionOrderNow fails → rollback fires, no orphan replacement", async () => {
  const { deps, calls } = makeDeps();
  const innerOrderNow = deps.subscriptionOrderNow;
  deps.subscriptionOrderNow = async (ws, cid) => {
    await innerOrderNow(ws, cid);
    return { success: false, error: "Braintree hold" };
  };
  const r = await issueDollarReplacement(WORKSPACE, makeArgs({
    refund: undefined,
    upcharge: { contractId: "contract-abc" },
  }), deps);
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /Upcharge failed after replacement created/);
  assert.equal(r.rolledBack, true);
  assert.equal(calls.rollback.length, 1);
  assert.equal(calls.rollback[0].replacementId, REPLACEMENT_ID);
});
