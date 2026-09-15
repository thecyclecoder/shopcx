/**
 * Cross-customer authorization regression for `full_order_refund` (spec:
 * full-order-refund-must-bind-ticket-customer).
 *
 * Fingerprint the code review of #2783 flagged: a founder-approved parked
 * remedy carries `shopify_order_id` in its payload. Before this fix, the
 * handler resolved that order by `(workspace_id, shopify_order_id)` only —
 * so a payload naming ANY order in the same workspace, including one owned
 * by a different customer, would refund that other customer's money after
 * founder approval. The fix binds the lookup to `ctx.customerId` and bails
 * BEFORE the refund module is loaded on mismatch, so no network side
 * effect can fire on refusal.
 *
 * Pure — no live DB, no live Braintree/Shopify. Uses an in-memory admin
 * fake shaped like supabase-js. Run:
 *   npx tsx --test src/lib/action-executor.full-order-refund-customer-binding.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { directActionHandlers, type ActionContext, type ActionParams } from "./action-executor";
import { hashActionRefundKey } from "./refund";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
interface Filter { col: string; val: unknown; op: "eq" | "in" }

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    const v = row[f.col];
    if (f.op === "eq") { if (v !== f.val) return false; continue }
    if (f.op === "in") {
      const set = f.val as unknown[];
      if (!Array.isArray(set) || !set.includes(v)) return false;
      continue;
    }
  }
  return true;
}

interface FakeChain {
  select: (...args: unknown[]) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  in: (col: string, vals: unknown[]) => FakeChain;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  single: () => Promise<{ data: Row | null; error: null }>;
}

function makeChain(tables: Tables, table: string): FakeChain {
  const filters: Filter[] = [];
  const chain: FakeChain = {
    select: () => chain,
    eq: (col, val) => { filters.push({ col, val, op: "eq" }); return chain },
    in: (col, vals) => { filters.push({ col, val: vals, op: "in" }); return chain },
    maybeSingle: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    single: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
  };
  return chain;
}

function makeAdmin(tables: Tables, touched: string[]) {
  return {
    from: (t: string) => {
      touched.push(t);
      return makeChain(tables, t);
    },
  } as unknown as ActionContext["admin"];
}

const WS = "ws-superfoods";
const CUST_TICKET = "cust-ticket";       // the ticket's identified customer
const CUST_OTHER = "cust-other";         // a different customer in same workspace
const ORDER_TICKET_SHOP_ID = "111111";   // Shopify id of the ticket customer's order
const ORDER_OTHER_SHOP_ID = "222222";    // Shopify id of the OTHER customer's order

function baseCtx(): ActionContext {
  return {
    admin: null as unknown as ActionContext["admin"],
    workspaceId: WS,
    ticketId: "tkt-1",
    customerId: CUST_TICKET,
    channel: "email",
    sandbox: false,
    _founderApprovedFullOrderRefund: true,
  };
}

// ─── FAIL-STATE: cross-customer refund is refused before refundOrder ───

test("cross-customer full_order_refund is refused even with founder approval, before refundOrder is called", async () => {
  const touched: string[] = [];
  const tables: Tables = {
    orders: [
      { id: "ord-ticket", workspace_id: WS, customer_id: CUST_TICKET, shopify_order_id: ORDER_TICKET_SHOP_ID, total_cents: 5000 },
      { id: "ord-other",  workspace_id: WS, customer_id: CUST_OTHER,  shopify_order_id: ORDER_OTHER_SHOP_ID,  total_cents: 9000 },
    ],
  };
  const ctx: ActionContext = { ...baseCtx(), admin: makeAdmin(tables, touched) };
  const params: ActionParams = { type: "full_order_refund", shopify_order_id: ORDER_OTHER_SHOP_ID };

  const result = await directActionHandlers.full_order_refund(ctx, params);

  assert.equal(result.success, false, "cross-customer refund MUST return success:false");
  assert.match(
    result.error ?? "",
    /ticket customer|not found/i,
    "error must reference the customer-scoped miss",
  );
  assert.equal(
    result.refundAmountCents,
    undefined,
    "no refund amount reported — no refund was authorised",
  );
  assert.ok(
    !touched.includes("order_refunds"),
    "handler must bail BEFORE any order_refunds bookkeeping — refundOrder path never entered",
  );
});

test("cross-customer refund by order_number (non-numeric id) is also refused", async () => {
  const touched: string[] = [];
  const tables: Tables = {
    orders: [
      { id: "ord-ticket", workspace_id: WS, customer_id: CUST_TICKET, order_number: "SUP-1001", total_cents: 5000 },
      { id: "ord-other",  workspace_id: WS, customer_id: CUST_OTHER,  order_number: "SUP-1002", total_cents: 9000 },
    ],
  };
  const ctx: ActionContext = { ...baseCtx(), admin: makeAdmin(tables, touched) };
  const params: ActionParams = { type: "full_order_refund", shopify_order_id: "SUP-1002" };

  const result = await directActionHandlers.full_order_refund(ctx, params);

  assert.equal(result.success, false);
  assert.ok(!touched.includes("order_refunds"));
});

test("missing ctx.customerId refuses full_order_refund up front — an unbound remedy cannot be authorised", async () => {
  const touched: string[] = [];
  const tables: Tables = {
    orders: [
      { id: "ord-ticket", workspace_id: WS, customer_id: CUST_TICKET, shopify_order_id: ORDER_TICKET_SHOP_ID, total_cents: 5000 },
    ],
  };
  const ctx: ActionContext = { ...baseCtx(), customerId: "", admin: makeAdmin(tables, touched) };
  const params: ActionParams = { type: "full_order_refund", shopify_order_id: ORDER_TICKET_SHOP_ID };

  const result = await directActionHandlers.full_order_refund(ctx, params);

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no ticket customer bound|unbound/i);
  assert.ok(
    !touched.includes("orders"),
    "handler bails before even the orders lookup when there is no bound customer",
  );
});

test("founder-approval gate still fires first — unapproved full_order_refund never reaches the customer-binding lookup", async () => {
  const touched: string[] = [];
  const tables: Tables = {
    orders: [
      { id: "ord-ticket", workspace_id: WS, customer_id: CUST_TICKET, shopify_order_id: ORDER_TICKET_SHOP_ID, total_cents: 5000 },
    ],
  };
  const ctx: ActionContext = { ...baseCtx(), admin: makeAdmin(tables, touched), _founderApprovedFullOrderRefund: false };
  const params: ActionParams = { type: "full_order_refund", shopify_order_id: ORDER_TICKET_SHOP_ID };

  const result = await directActionHandlers.full_order_refund(ctx, params);

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /founder-approval-only/i);
  assert.ok(touched.length === 0, "no DB touches on the founder-approval refusal path");
});

// ─── PASS-STATE: same-customer refund still succeeds via the idempotency
// short-circuit and reports the order's collected total. The idempotency
// row proves the lookup found the order through the new customer_id filter
// AND that the handler reports the order's total_cents as the refund
// amount — without calling refundOrder on the network.

test("same-customer founder-approved full_order_refund still finds the order and reports the collected total", async () => {
  const touched: string[] = [];
  const reason = "Full order refund — founder-authorised";
  const refundCents = 5000;
  const requestKey = hashActionRefundKey("ticket", "tkt-1", "ord-ticket", refundCents, reason);
  const tables: Tables = {
    orders: [
      { id: "ord-ticket", workspace_id: WS, customer_id: CUST_TICKET, shopify_order_id: ORDER_TICKET_SHOP_ID, total_cents: refundCents },
      { id: "ord-other",  workspace_id: WS, customer_id: CUST_OTHER,  shopify_order_id: ORDER_OTHER_SHOP_ID,  total_cents: 9000 },
    ],
    // Seed the idempotency row so refundOrder is short-circuited (a retry
    // of the same action returns the prior success without re-firing).
    order_refunds: [
      {
        id: "refund-1",
        workspace_id: WS,
        order_id: "ord-ticket",
        request_key: requestKey,
        status: "succeeded",
        amount_cents: refundCents,
        vendor_refund_id: "prior-txn-abc",
      },
    ],
  };
  const ctx: ActionContext = { ...baseCtx(), admin: makeAdmin(tables, touched) };
  const params: ActionParams = { type: "full_order_refund", shopify_order_id: ORDER_TICKET_SHOP_ID };

  const result = await directActionHandlers.full_order_refund(ctx, params);

  assert.equal(result.success, true, "same-customer founder-approved refund still succeeds");
  assert.equal(result.refundAmountCents, refundCents, "refund amount reported is the order's collected total");
  assert.match(result.summary ?? "", /already fired/, "short-circuit summary indicates idempotency reuse");
});
