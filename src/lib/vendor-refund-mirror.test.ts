/**
 * Tests for the vendor-side refund mirror.
 *
 * The mirror is what closes the SC137733 class — a refund issued in the
 * Shopify admin was invisible to the double-refund guard because
 * order_refunds is only written by refundOrder. These tests pin:
 *
 *   1. parseShopifyRefundPayload sums only `kind='refund'` transactions
 *      and never counts a failure/error transaction.
 *   2. insertShopifyRefundMirror writes one row for a fresh vendor
 *      refund, and short-circuits (no row, no duplicate) when the same
 *      vendor_refund_id is already in the ledger — the semantic guard
 *      that keeps refundOrder's own mirror insert from colliding with
 *      the webhook echo of the same refund.
 *   3. The request_key is derived from the shopify refund id, so a
 *      re-delivered webhook hits the unique index rather than writing a
 *      second row.
 *
 * Run:
 *   npx tsx --test src/lib/vendor-refund-mirror.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type LedgerRow = {
  workspace_id: string;
  order_id: string;
  request_key: string;
  vendor: string;
  vendor_refund_id: string | null;
  amount_cents: number;
  status: string;
  source: string;
};

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const ORDER_ID = "22222222-2222-2222-2222-222222222222";
const SHOPIFY_ORDER_ID = "444455556666";

const ledger: LedgerRow[] = [];
let orderLookupCalls = 0;
let orderLookupResult: { id: string } | null = { id: ORDER_ID };

function resetWorld(): void {
  ledger.length = 0;
  orderLookupCalls = 0;
  orderLookupResult = { id: ORDER_ID };
}

interface QueryBuilder {
  select(cols: string): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  insert(row: Record<string, unknown>): Promise<{ data: null; error: { code: string; message: string } | null }>;
}

function makeFrom(table: string): QueryBuilder {
  const filters: Record<string, unknown> = {};
  const builder: QueryBuilder = {
    select(_cols) {
      return builder;
    },
    eq(col, val) {
      filters[col] = val;
      return builder;
    },
    async maybeSingle() {
      if (table === "orders") {
        orderLookupCalls++;
        return { data: orderLookupResult, error: null };
      }
      if (table === "order_refunds") {
        const hit = ledger.find(
          (r) =>
            r.workspace_id === filters.workspace_id &&
            r.order_id === filters.order_id &&
            r.vendor === filters.vendor &&
            r.vendor_refund_id === filters.vendor_refund_id,
        );
        return { data: hit ?? null, error: null };
      }
      return { data: null, error: null };
    },
    async insert(row) {
      if (table === "order_refunds") {
        const r = row as LedgerRow;
        const collision = ledger.find(
          (existing) => existing.order_id === r.order_id && existing.request_key === r.request_key,
        );
        if (collision) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        ledger.push(r);
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

const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  parseShopifyRefundPayload,
  insertShopifyRefundMirror,
  shopifyRefundRequestKey,
  decideFinancialStatusBackfill,
  backfillFromFinancialStatusRequestKey,
} = require("@/lib/vendor-refund-mirror") as typeof import("./vendor-refund-mirror");

test("parseShopifyRefundPayload sums only succeeded/pending refund transactions", () => {
  const parsed = parseShopifyRefundPayload({
    id: "9001",
    order_id: "444455556666",
    transactions: [
      { kind: "refund", status: "success", amount: "12.34" },
      { kind: "refund", status: "success", amount: "5.00" },
      { kind: "refund", status: "failure", amount: "99.00" },
      { kind: "sale", status: "success", amount: "17.34" },
    ],
  });
  assert.notEqual(parsed, null);
  assert.equal(parsed!.amountCents, 1234 + 500);
  assert.equal(parsed!.hasSuccessfulTransaction, true);
  assert.equal(parsed!.shopifyRefundId, "9001");
  assert.equal(parsed!.shopifyOrderId, "444455556666");
});

test("parseShopifyRefundPayload returns null on missing id/order_id", () => {
  assert.equal(parseShopifyRefundPayload({ id: "1" }), null);
  assert.equal(parseShopifyRefundPayload({ order_id: "1" }), null);
  assert.equal(parseShopifyRefundPayload(null), null);
});

test("insertShopifyRefundMirror writes one row for a fresh vendor refund", async () => {
  resetWorld();
  const parsed = parseShopifyRefundPayload({
    id: "9002",
    order_id: SHOPIFY_ORDER_ID,
    transactions: [{ kind: "refund", status: "success", amount: "10.00" }],
  });
  const result = await insertShopifyRefundMirror(WORKSPACE_ID, parsed!);
  assert.equal(result.inserted, true);
  assert.equal(ledger.length, 1);
  const row = ledger[0];
  assert.equal(row.vendor, "shopify");
  assert.equal(row.vendor_refund_id, "9002");
  assert.equal(row.amount_cents, 1000);
  assert.equal(row.status, "succeeded");
  assert.equal(row.source, "live");
  assert.equal(row.request_key, shopifyRefundRequestKey("9002"));
});

test("insertShopifyRefundMirror skips when a row already exists with the same vendor_refund_id (refundOrder-echo semantic guard)", async () => {
  resetWorld();
  // Pre-seed the ledger with a refundOrder-authored row that carries the
  // same shopify refund id but a DIFFERENT request_key (the hashRefundRequestKey
  // shape-based key). A dumb insert would land a duplicate because the
  // unique index is on (order_id, request_key) and keys differ.
  ledger.push({
    workspace_id: WORKSPACE_ID,
    order_id: ORDER_ID,
    request_key: "content-hash-abcdef",
    vendor: "shopify",
    vendor_refund_id: "9003",
    amount_cents: 1000,
    status: "succeeded",
    source: "live",
  });
  const parsed = parseShopifyRefundPayload({
    id: "9003",
    order_id: SHOPIFY_ORDER_ID,
    transactions: [{ kind: "refund", status: "success", amount: "10.00" }],
  });
  const result = await insertShopifyRefundMirror(WORKSPACE_ID, parsed!);
  assert.equal(result.inserted, false);
  assert.equal(ledger.length, 1);
});

test("insertShopifyRefundMirror is idempotent on re-delivered webhook (same request_key)", async () => {
  resetWorld();
  const parsed = parseShopifyRefundPayload({
    id: "9004",
    order_id: SHOPIFY_ORDER_ID,
    transactions: [{ kind: "refund", status: "success", amount: "20.00" }],
  });
  const first = await insertShopifyRefundMirror(WORKSPACE_ID, parsed!);
  assert.equal(first.inserted, true);
  assert.equal(ledger.length, 1);

  // Second call — same shopify refund id ⇒ same request_key ⇒ unique
  // index catches it. Purge the semantic-guard row to force the insert
  // path, then confirm the unique-key branch resolves to already_mirrored.
  ledger[0].vendor_refund_id = null;
  const second = await insertShopifyRefundMirror(WORKSPACE_ID, parsed!);
  assert.equal(second.inserted, false);
  assert.equal(ledger.length, 1);
});

test("insertShopifyRefundMirror returns order_not_found when the shopify_order_id is unknown", async () => {
  resetWorld();
  orderLookupResult = null;
  const parsed = parseShopifyRefundPayload({
    id: "9005",
    order_id: "9999999",
    transactions: [{ kind: "refund", status: "success", amount: "1.00" }],
  });
  const result = await insertShopifyRefundMirror(WORKSPACE_ID, parsed!);
  assert.equal(result.inserted, false);
  assert.equal(ledger.length, 0);
});

test("insertShopifyRefundMirror refuses to write a zero-amount row (vendor didn't move money)", async () => {
  resetWorld();
  const parsed = parseShopifyRefundPayload({
    id: "9006",
    order_id: SHOPIFY_ORDER_ID,
    transactions: [{ kind: "refund", status: "failure", amount: "10.00" }],
  });
  const result = await insertShopifyRefundMirror(WORKSPACE_ID, parsed!);
  assert.equal(result.inserted, false);
  assert.equal(ledger.length, 0);
});

// ── Phase 2: backfill decision predicate ─────────────────────────────

test("decideFinancialStatusBackfill: writes the gap for a fully-refunded order with no ledger record", () => {
  const decision = decideFinancialStatusBackfill({
    financialStatus: "refunded",
    totalCents: 3000,
    mirroredSuccessSettledCents: 0,
  });
  assert.equal(decision.skip, false);
  if (!decision.skip) assert.equal(decision.gapCents, 3000);
});

test("decideFinancialStatusBackfill: writes the gap when the ledger is partial", () => {
  const decision = decideFinancialStatusBackfill({
    financialStatus: "refunded",
    totalCents: 3000,
    mirroredSuccessSettledCents: 1000,
  });
  assert.equal(decision.skip, false);
  if (!decision.skip) assert.equal(decision.gapCents, 2000);
});

test("decideFinancialStatusBackfill: SC137733 idempotency proof — a hand-reconciled order is skipped", () => {
  // The spec explicitly names SC137733 as reconciled by hand on 2026-09-11.
  // After reconciliation, its mirrored sum matches total_cents, so the
  // decision predicate must skip it with `already_covered` — that's the
  // proof the backfill is idempotent on a row it already covered.
  const decision = decideFinancialStatusBackfill({
    financialStatus: "refunded",
    totalCents: 4500,
    mirroredSuccessSettledCents: 4500,
  });
  assert.equal(decision.skip, true);
  if (decision.skip) assert.equal(decision.reason, "already_covered");
});

test("decideFinancialStatusBackfill: skips partially_refunded (no unambiguous expected value)", () => {
  const decision = decideFinancialStatusBackfill({
    financialStatus: "partially_refunded",
    totalCents: 3000,
    mirroredSuccessSettledCents: 0,
  });
  assert.equal(decision.skip, true);
  if (decision.skip) assert.equal(decision.reason, "not_fully_refunded");
});

test("decideFinancialStatusBackfill: accepts mixed-case 'REFUNDED' (Shopify's raw casing)", () => {
  const decision = decideFinancialStatusBackfill({
    financialStatus: "REFUNDED",
    totalCents: 1000,
    mirroredSuccessSettledCents: 0,
  });
  assert.equal(decision.skip, false);
  if (!decision.skip) assert.equal(decision.gapCents, 1000);
});

test("decideFinancialStatusBackfill: skips an over-mirrored order (defensive over_total guard)", () => {
  const decision = decideFinancialStatusBackfill({
    financialStatus: "refunded",
    totalCents: 1000,
    mirroredSuccessSettledCents: 1500,
  });
  assert.equal(decision.skip, true);
  if (decision.skip) assert.equal(decision.reason, "already_covered");
});

test("decideFinancialStatusBackfill: skips when total_cents is 0 or missing", () => {
  assert.equal(
    decideFinancialStatusBackfill({
      financialStatus: "refunded",
      totalCents: 0,
      mirroredSuccessSettledCents: 0,
    }).skip,
    true,
  );
  assert.equal(
    decideFinancialStatusBackfill({
      financialStatus: "refunded",
      totalCents: null,
      mirroredSuccessSettledCents: 0,
    }).skip,
    true,
  );
});

test("backfillFromFinancialStatusRequestKey is stable per order_id (idempotent re-runs)", () => {
  const a = backfillFromFinancialStatusRequestKey("22222222-2222-2222-2222-222222222222");
  const b = backfillFromFinancialStatusRequestKey("22222222-2222-2222-2222-222222222222");
  assert.equal(a, b);
  assert.equal(a, "backfill:financial_status:22222222-2222-2222-2222-222222222222");
});
