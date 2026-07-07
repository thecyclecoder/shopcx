/**
 * Pre-dispatch idempotency guard test for refundOrder.
 * (Phase 1 of docs/brain/specs/refund-idempotency-guard-in-commerce-refund-facade.md.)
 *
 * Pins the invariant this phase restores at the choke point:
 *
 *   1. Two calls with the same (order, amount, reason) fire the gateway
 *      ONCE — the second call short-circuits via the order_refunds
 *      lookup and returns success without dispatching.
 *   2. A distinct amount or reason is NOT short-circuited — the ledger
 *      returns no row and the gateway fires again.
 *   3. dryRun does not consult (or write to) the ledger.
 *
 * We stub the Supabase admin client + gateway modules through Node's
 * ESM module cache BEFORE dynamic-importing `./refund`. The stub client
 * mocks the (workspace_id, order_id, request_key, status ∈ succeeded/settled)
 * lookup that Phase 1 added right before the branch dispatch, and
 * counts gateway calls.
 *
 * Run:
 *   npx tsx --test src/lib/refund.guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ── Ledger stub ───────────────────────────────────────────────────
// The stub Supabase client is a tiny in-memory ledger with just the
// two operations refundOrder issues against `order_refunds`:
//   .select().eq()* .in().maybeSingle() — the pre-dispatch guard read
//   .insert(row)                         — the post-success mirror write
// and the two operations refundOrder issues against `orders` +
// `returns` (single-row lookup + best-effort stamp).

type LedgerRow = {
  workspace_id: string;
  order_id: string;
  request_key: string;
  vendor: "braintree" | "shopify" | "internal";
  vendor_refund_id?: string | null;
  amount_cents: number;
  status: "requested" | "succeeded" | "failed" | "settled" | "reversed";
};

const ORDER_ID = "22222222-2222-2222-2222-222222222222";
const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";

const ledger: LedgerRow[] = [];
let braintreeCalls = 0;

function resetWorld(): void {
  ledger.length = 0;
  braintreeCalls = 0;
}

// A minimal query-builder chain that supports the two access shapes
// used by refundOrder. Each `.eq/.in/.select` returns the same builder
// so any order works.
function ordersRow() {
  return {
    id: ORDER_ID,
    shopify_order_id: null as string | null,
    braintree_transaction_id: "bt-txn-1",
    customer_id: "cust-1",
    order_number: "SC000001",
  };
}

interface QueryBuilder {
  select(cols: string): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  in(col: string, vals: unknown[]): QueryBuilder;
  is(col: string, val: unknown): QueryBuilder;
  update(patch: Record<string, unknown>): QueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  insert(row: LedgerRow): Promise<{ data: null; error: null }>;
}

function makeFrom(table: string): QueryBuilder {
  const filters: Record<string, unknown> = {};
  const inFilters: Record<string, unknown[]> = {};
  const builder: QueryBuilder = {
    select(_cols) {
      return builder;
    },
    eq(col, val) {
      filters[col] = val;
      return builder;
    },
    in(col, vals) {
      inFilters[col] = vals;
      return builder;
    },
    is(_col, _val) {
      return builder;
    },
    update(_patch) {
      return builder;
    },
    async maybeSingle() {
      if (table === "orders") {
        return { data: ordersRow(), error: null };
      }
      if (table === "order_refunds") {
        const status = (inFilters.status as string[] | undefined) ?? [];
        const hit = ledger.find(
          (r) =>
            r.workspace_id === filters.workspace_id &&
            r.order_id === filters.order_id &&
            r.request_key === filters.request_key &&
            status.includes(r.status),
        );
        return { data: hit ?? null, error: null };
      }
      return { data: null, error: null };
    },
    async insert(row) {
      if (table === "order_refunds") {
        ledger.push(row);
      }
      return { data: null, error: null };
    },
  };
  return builder;
}

const stubAdmin = {
  from(table: string) {
    return makeFrom(table);
  },
};

// Wire the stubs into Node's module cache BEFORE we import refund.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};
moduleAny._cache[require.resolve("@/lib/integrations/braintree")] = {
  exports: {
    refundBraintreeTransaction: async (
      _workspaceId: string,
      _txnId: string,
      _amountCents: number,
    ) => {
      braintreeCalls++;
      return { success: true, refundId: `bt-refund-${braintreeCalls}` };
    },
  },
};
moduleAny._cache[require.resolve("@/lib/shopify-order-actions")] = {
  exports: {
    partialRefundByAmount: async () => ({ success: true, method: "shopify" as const }),
    recordManualRefund: async () => ({ success: true }),
  },
};
moduleAny._cache[require.resolve("@/lib/customer-events")] = {
  exports: { logCustomerEvent: async () => undefined },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { refundOrder, hashRefundRequestKey } = require("@/lib/refund") as typeof import("./refund");

// ── Tests ─────────────────────────────────────────────────────────

test("guard: same-shape retry fires gateway ONCE (second call short-circuits via order_refunds)", async () => {
  resetWorld();
  const first = await refundOrder(WORKSPACE_ID, ORDER_ID, 500, "customer overcharged");
  assert.equal(first.success, true);
  assert.equal(first.method, "braintree");
  assert.equal(braintreeCalls, 1);
  assert.equal(ledger.length, 1);

  const second = await refundOrder(WORKSPACE_ID, ORDER_ID, 500, "customer overcharged");
  assert.equal(second.success, true);
  assert.equal(second.method, "braintree");
  assert.equal(second.refund_id, "bt-refund-1");
  // Braintree NOT called a second time — the pre-dispatch guard hit.
  assert.equal(braintreeCalls, 1);
  // No duplicate mirror row.
  assert.equal(ledger.length, 1);
});

test("guard: distinct amount is NOT short-circuited (different request_key ⇒ gateway fires again)", async () => {
  resetWorld();
  await refundOrder(WORKSPACE_ID, ORDER_ID, 500, "customer overcharged");
  assert.equal(braintreeCalls, 1);

  const different = await refundOrder(WORKSPACE_ID, ORDER_ID, 750, "customer overcharged");
  assert.equal(different.success, true);
  assert.equal(braintreeCalls, 2);
  assert.equal(ledger.length, 2);
});

test("guard: distinct reason is NOT short-circuited (different request_key ⇒ gateway fires again)", async () => {
  resetWorld();
  await refundOrder(WORKSPACE_ID, ORDER_ID, 500, "reason-a");
  const other = await refundOrder(WORKSPACE_ID, ORDER_ID, 500, "reason-b");
  assert.equal(other.success, true);
  assert.equal(braintreeCalls, 2);
  assert.equal(ledger.length, 2);
});

test("guard: explicit opts.requestKey overrides the default hash and dedups on caller identity", async () => {
  resetWorld();
  // Two calls with identical (order, amount, reason) but callers pass
  // distinct requestKeys — both should fire the gateway.
  await refundOrder(WORKSPACE_ID, ORDER_ID, 500, "same", { requestKey: "action-a" });
  await refundOrder(WORKSPACE_ID, ORDER_ID, 500, "same", { requestKey: "action-b" });
  assert.equal(braintreeCalls, 2);

  // A retry of action-a with its stable key short-circuits.
  await refundOrder(WORKSPACE_ID, ORDER_ID, 500, "same", { requestKey: "action-a" });
  assert.equal(braintreeCalls, 2);
});

test("guard: dryRun does not consult the ledger and does not fire the gateway", async () => {
  resetWorld();
  const r = await refundOrder(WORKSPACE_ID, ORDER_ID, 0, "probe", { dryRun: true });
  assert.equal(r.success, true);
  assert.equal(r.dryRun, true);
  assert.equal(braintreeCalls, 0);
  assert.equal(ledger.length, 0);
});

test("guard: hashRefundRequestKey is deterministic over (order, amount, reason)", () => {
  const k1 = hashRefundRequestKey(ORDER_ID, 500, "customer overcharged");
  const k2 = hashRefundRequestKey(ORDER_ID, 500, "customer overcharged");
  const k3 = hashRefundRequestKey(ORDER_ID, 750, "customer overcharged");
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});
