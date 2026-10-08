/**
 * Unit tests for Phase 1 of assisted-one-time-orders-charge-and-ship:
 * create_order on internal billing charges the vaulted card + ships via
 * chargeOneTimeOrder instead of writing a bare, unpaid, unshipped mirror row.
 *
 * The failing states the spec names, asserted via the injectable charge fn
 * (chargeOneTimeOrder's own money path hits Braintree / Amplifier / Avalara, so
 * executeInternalOneTimeCreate takes it as a parameter the handler fills with
 * the real primitive in production and the test fills with a spy):
 *
 *   (1) success          → the REAL order number + charged total are in the
 *                          result (and thread into the customer confirmation).
 *   (2) charge failure    → success:false, NO order_number, no confirmation.
 *   (3) same request key  → NO second charge (idempotent on a re-sessioned turn).
 *   (4) amplifier failure → success:false + the ticket is escalated to CS (June)
 *                          rather than reported as a clean success.
 *
 * Plus interpretAssistedCreateResult: the confirmation quotes the real order
 * number + amount (the "confirmation carries the real order number" bullet).
 *
 * Pure — no live DB. Uses an in-memory fake admin covering the idempotency
 * `transactions` read + escalateTicket's `tickets` update.
 *
 * Run: `npx tsx --test src/lib/action-executor.create-order-charges.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  executeInternalOneTimeCreate,
  assistedOrderRequestKey,
  type ActionContext,
  type ActionParams,
} from "./action-executor";
import { interpretAssistedCreateResult } from "./playbook-executor";
import type { OneTimeChargeInput, OneTimeChargeResult } from "./one-time-charge";

// ── Fake admin: covers the transactions idempotency read + tickets update ──

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface UpdateLog {
  table: string;
  row: Row;
}

function getNested(row: Row, col: string): unknown {
  // Support PostgREST jsonb arrow: "metadata->>request_key".
  const m = col.match(/^(\w+)->>(\w+)$/);
  if (!m) return row[col];
  const container = row[m[1]] as Record<string, unknown> | undefined;
  return container ? container[m[2]] : undefined;
}

function makeAdmin(tables: Tables, updates: UpdateLog[]): ActionContext["admin"] {
  return {
    from(table: string) {
      const eqFilters: Array<[string, unknown]> = [];
      const inFilters: Array<[string, unknown[]]> = [];
      const resolve = () => {
        const all = tables[table] ?? [];
        const rows = all.filter((r) => {
          for (const [c, v] of eqFilters) if (getNested(r, c) !== v) return false;
          for (const [c, vs] of inFilters) if (!vs.includes(getNested(r, c) as unknown)) return false;
          return true;
        });
        return { data: rows, error: null };
      };
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          eqFilters.push([col, val]);
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          inFilters.push([col, vals]);
          return chain;
        },
        then: <T>(cb: (r: { data: Row[]; error: null }) => T) => Promise.resolve(cb(resolve())),
        update: (row: Row) => ({
          eq: (_c: string, _v: unknown) => {
            updates.push({ table, row });
            return Promise.resolve({ error: null });
          },
        }),
      };
      return chain;
    },
  } as unknown as ActionContext["admin"];
}

function makeCtx(tables: Tables, updates: UpdateLog[] = []): ActionContext {
  return {
    admin: makeAdmin(tables, updates),
    workspaceId: "ws-1",
    ticketId: "t-1",
    customerId: "c-1",
    channel: "chat",
    sandbox: true,
  };
}

const LINE_ITEMS: NonNullable<ActionParams["line_items"]> = [
  { variant_id: "v-1", title: "K-Cups", quantity: 1, unit_cents: 5996 },
];
// The request key the guard derives for LINE_ITEMS on ticket t-1 — derived via
// the real helper so the idempotency fixture can never drift from production.
const REQUEST_KEY = assistedOrderRequestKey("t-1", LINE_ITEMS);

function spyCharge(result: OneTimeChargeResult): {
  fn: (input: OneTimeChargeInput) => Promise<OneTimeChargeResult>;
  calls: OneTimeChargeInput[];
} {
  const calls: OneTimeChargeInput[] = [];
  return {
    calls,
    fn: async (input) => {
      calls.push(input);
      return result;
    },
  };
}

// ── double-charge guard key — exact value + order-independence ─────────

test("assistedOrderRequestKey — stable, order-independent key (the double-charge guard)", () => {
  assert.equal(assistedOrderRequestKey("t-1", LINE_ITEMS), "shopcx-concierge:t-1:v-1:1:5996");
  // Re-ordering the line items must NOT change the key — a re-sessioned turn
  // that lists the same items in a different order is the SAME charge.
  const a = assistedOrderRequestKey("t-9", [
    { variant_id: "v-a", title: "A", quantity: 2, unit_cents: 100 },
    { variant_id: "v-b", title: "B", quantity: 1, unit_cents: 200 },
  ]);
  const b = assistedOrderRequestKey("t-9", [
    { variant_id: "v-b", title: "B", quantity: 1, unit_cents: 200 },
    { variant_id: "v-a", title: "A", quantity: 2, unit_cents: 100 },
  ]);
  assert.equal(a, b);
  // A different ticket is a different charge.
  assert.notEqual(assistedOrderRequestKey("t-1", LINE_ITEMS), assistedOrderRequestKey("t-2", LINE_ITEMS));
});

// ── (1) success → real order number + charged total on the result ──────

test("create_order internal — charge succeeds → order number + amount on the result", async () => {
  const ctx = makeCtx({ transactions: [] });
  const charge = spyCharge({ success: true, order_number: "SHOPCX777", amount_cents: 5996 });

  const r = await executeInternalOneTimeCreate(ctx, LINE_ITEMS, "pm-1", null, charge.fn);

  assert.equal(r.success, true);
  assert.equal(r.order_number, "SHOPCX777");
  assert.equal(r.amount_cents, 5996);
  assert.match(r.summary || "", /SHOPCX777/);
  assert.match(r.summary || "", /59\.96/);

  // The primitive was called exactly once, with the idempotency key and the
  // server-resolved price mapped onto unit_price_cents.
  assert.equal(charge.calls.length, 1);
  assert.equal(charge.calls[0].requestKey, REQUEST_KEY);
  assert.equal(charge.calls[0].sourceName, "shopcx-concierge");
  assert.equal(charge.calls[0].paymentMethodId, "pm-1");
  assert.deepEqual(charge.calls[0].items, [
    { variant_id: "v-1", quantity: 1, unit_price_cents: 5996 },
  ]);
});

// ── (2) charge failure → success:false, NO confirmation ────────────────

test("create_order internal — charge declines → success:false and no order number", async () => {
  const ctx = makeCtx({ transactions: [] });
  const charge = spyCharge({ success: false, error: "charge_declined", details: "Insufficient Funds" });

  const r = await executeInternalOneTimeCreate(ctx, LINE_ITEMS, "pm-1", null, charge.fn);

  assert.equal(r.success, false);
  assert.equal(r.order_number, undefined);
  assert.equal(r.amount_cents, undefined);
  assert.equal(r.error, "charge_declined");
  assert.match(r.summary || "", /Create order failed/);
  assert.match(r.summary || "", /charge_declined/);
});

// ── (3) same request key → NO second charge (idempotent) ───────────────

test("create_order internal — a prior succeeded charge for the same key → NOT charged again", async () => {
  const updates: UpdateLog[] = [];
  const ctx = makeCtx(
    {
      transactions: [
        {
          id: "txn-prior",
          workspace_id: "ws-1",
          customer_id: "c-1",
          status: "succeeded",
          amount_cents: 5996,
          metadata: { request_key: REQUEST_KEY, order_number: "SHOPCX777" },
        },
      ],
    },
    updates,
  );
  const charge = spyCharge({ success: true, order_number: "SHOULD_NOT_BE_USED", amount_cents: 1 });

  const r = await executeInternalOneTimeCreate(ctx, LINE_ITEMS, "pm-1", null, charge.fn);

  // The primitive was NEVER called — the guard short-circuited on the prior row.
  assert.equal(charge.calls.length, 0);
  assert.equal(r.success, true);
  assert.equal(r.order_number, "SHOPCX777");
  assert.equal(r.amount_cents, 5996);
  assert.match(r.summary || "", /already charged/);
});

test("create_order internal — a FAILED prior charge for the same key does NOT block a retry", async () => {
  const charge = spyCharge({ success: true, order_number: "SHOPCX778", amount_cents: 5996 });
  const ctx = makeCtx({
    transactions: [
      {
        id: "txn-prior-failed",
        workspace_id: "ws-1",
        customer_id: "c-1",
        status: "failed", // declined — not in (pending, succeeded), so retry is allowed
        amount_cents: 5996,
        metadata: { request_key: REQUEST_KEY, order_number: "SHOPCX777" },
      },
    ],
  });

  const r = await executeInternalOneTimeCreate(ctx, LINE_ITEMS, "pm-1", null, charge.fn);

  assert.equal(charge.calls.length, 1, "a declined prior charge must be retryable");
  assert.equal(r.success, true);
  assert.equal(r.order_number, "SHOPCX778");
});

// ── (4) amplifier failure → success:false + escalated to CS (June) ─────

test("create_order internal — charged but Amplifier push failed → success:false + ticket escalated", async () => {
  const updates: UpdateLog[] = [];
  const ctx = makeCtx({ transactions: [] }, updates);
  const charge = spyCharge({
    success: true,
    order_number: "SHOPCX779",
    amount_cents: 5996,
    amplifier_error: "amplifier timeout",
  });

  const r = await executeInternalOneTimeCreate(ctx, LINE_ITEMS, "pm-1", null, charge.fn);

  assert.equal(r.success, false, "a charge the warehouse never received must not report clean success");
  assert.match(String(r.error), /amplifier_error/);
  assert.equal(r.order_number, "SHOPCX779", "the order number is still surfaced for the audit trail");
  assert.match(r.summary || "", /warehouse/);

  // The ticket was escalated (escalated_to:null → the CS routine, June's domain).
  const ticketUpdates = updates.filter((u) => u.table === "tickets");
  assert.equal(ticketUpdates.length, 1);
  assert.equal(ticketUpdates[0].row.escalated_to, null);
  assert.match(String(ticketUpdates[0].row.escalation_reason), /Amplifier push failed/);
});

// ── confirmation copy — interpretAssistedCreateResult quotes the order ──

test("interpretAssistedCreateResult — success quotes the real order number + charged total", () => {
  const v = interpretAssistedCreateResult({
    actionType: "create_order",
    result: { success: true, summary: "Charged and placed order SHOPCX777 for $59.96.", order_number: "SHOPCX777", amount_cents: 5996 },
  });
  assert.equal(v.action, "complete");
  assert.match(v.response, /SHOPCX777/);
  assert.match(v.response, /59\.96/);
  assert.equal(v.context.assisted_purchase_order_number, "SHOPCX777");
  assert.equal(v.context.assisted_purchase_amount_cents, 5996);
});

test("interpretAssistedCreateResult — failure never emits a placement confirmation", () => {
  const v = interpretAssistedCreateResult({
    actionType: "create_order",
    result: { success: false, error: "charge_declined" },
  });
  assert.equal(v.action, "respond");
  assert.doesNotMatch(v.response, /placed|on its way/i);
});
