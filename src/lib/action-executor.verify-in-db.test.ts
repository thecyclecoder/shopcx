/**
 * Unit tests for verifyActionInDB — the self-heal read-back gate that
 * decides whether the executor sends the customer-facing "I did it"
 * message or falls through to escalate. This test file covers the
 * Phase-1 extension (verify-action-in-db-coverage-expand-past-seven-types)
 * that adds create_return / create_replacement / skip_next_order /
 * change_next_date / change_frequency cases on top of the original
 * seven action types.
 *
 * Pure — no live DB. Uses an in-memory fake admin with just enough
 * chain surface (select/eq/order/limit/single/maybeSingle) to
 * satisfy the verifyActionInDB switch. Run:
 *   npx tsx --test src/lib/action-executor.verify-in-db.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { verifyActionInDB, type ActionParams } from "./action-executor";

// ── In-memory fake admin ──────────────────────────────────────────────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Filter {
  kind: "eq";
  col: string;
  val: unknown;
}

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    if (row[f.col] !== f.val) return false;
  }
  return true;
}

interface FakeChain {
  select: (...args: unknown[]) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  order: (col: string, opts?: { ascending?: boolean }) => FakeChain;
  limit: (n: number) => FakeChain;
  single: () => Promise<{ data: Row | null; error: null }>;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
}

function makeChain(tables: Tables, table: string): FakeChain {
  const filters: Filter[] = [];
  let orderCol: string | null = null;
  let orderAsc = true;
  let limitN: number | null = null;
  const resolve = () => {
    const all = tables[table] ?? [];
    let rows = all.filter((r) => matches(r, filters));
    if (orderCol) {
      const oc = orderCol;
      rows = [...rows].sort((a, b) => {
        const va = String(a[oc] ?? "");
        const vb = String(b[oc] ?? "");
        return orderAsc ? (va < vb ? -1 : va > vb ? 1 : 0) : (va > vb ? -1 : va < vb ? 1 : 0);
      });
    }
    if (limitN != null) rows = rows.slice(0, limitN);
    return { data: rows, error: null as null };
  };
  const chain: FakeChain = {
    select: () => chain,
    eq: (col, val) => {
      filters.push({ kind: "eq", col, val });
      return chain;
    },
    order: (col, opts) => {
      orderCol = col;
      orderAsc = opts?.ascending !== false;
      return chain;
    },
    limit: (n) => {
      limitN = n;
      return chain;
    },
    single: async () => {
      const r = resolve();
      return { data: r.data[0] ?? null, error: null };
    },
    maybeSingle: async () => {
      const r = resolve();
      return { data: r.data[0] ?? null, error: null };
    },
  };
  return chain;
}

function makeAdmin(tables: Tables) {
  return {
    from(table: string) {
      return makeChain(tables, table);
    },
  } as unknown as Parameters<typeof verifyActionInDB>[0]["admin"];
}

function makeCtx(tables: Tables, ticketId = "ticket-1") {
  return { admin: makeAdmin(tables), ticketId };
}

// ── create_return / create_replacement ────────────────────────────────
// The predicate reads returns.status via the LIVE DB enum that
// createFullReturn actually writes: 'open' at row-insert (shopify-returns.ts:210,781),
// 'label_created' after EasyPost issues the label (line 327,944), then
// 'in_transit'/'delivered'/'refunded'/'restocked'/'closed' downstream.
// Only 'cancelled' means "not a real return" — verified is: row exists AND
// status ≠ 'cancelled'.

test("create_return — happy path: status='open' (the state createFullReturn writes at insert) → verified TRUE", async () => {
  // Fix-1 regression test: the initial Phase-1 landing gated on
  // ('pending','approved'), which no code path writes — every real
  // successful create_return would have been flagged as failed and
  // false-positive-escalated. This test pins the fix to the real enum.
  const ctx = makeCtx({
    returns: [
      { id: "r1", ticket_id: "ticket-1", status: "open", created_at: "2026-07-06T10:00:00Z" },
    ],
  });
  const action: ActionParams = { type: "create_return", order_number: "12345" };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("create_return — status='label_created' (post-EasyPost) → verified TRUE", async () => {
  const ctx = makeCtx({
    returns: [
      { id: "r1", ticket_id: "ticket-1", status: "label_created", created_at: "2026-07-06T10:00:00Z" },
    ],
  });
  const action: ActionParams = { type: "create_return", order_number: "12345" };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("create_return — later-lifecycle status ('in_transit'/'delivered'/'refunded') still verifies TRUE", async () => {
  for (const status of ["in_transit", "delivered", "refunded", "restocked", "closed"] as const) {
    const ctx = makeCtx({
      returns: [
        { id: "r1", ticket_id: "ticket-1", status, created_at: "2026-07-06T10:00:00Z" },
      ],
    });
    const action: ActionParams = { type: "create_return", order_number: "12345" };
    assert.equal(await verifyActionInDB(ctx, action), true, `status=${status} should verify true`);
  }
});

test("create_return — HANDLER SAID SUCCESS but returns row was never inserted → verified FALSE (self-heal retries)", async () => {
  // The named failing state the spec's Verification bullet #1 calls out:
  // the create_return handler returned success but no returns row exists
  // for the ticket. verifyActionInDB must return false so the executor's
  // self-heal loop retries once and escalates on repeat failure.
  const ctx = makeCtx({ returns: [] });
  const action: ActionParams = { type: "create_return", order_number: "12345" };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("create_return — only a cancelled row exists on this ticket → verified FALSE", async () => {
  // A cancelled return is not a live one. Cancelled rows sort newest but
  // the ordered-by-newest limit-1 query lands on it and the status !∈
  // ('pending','approved') gate rejects.
  const ctx = makeCtx({
    returns: [
      { id: "r1", ticket_id: "ticket-1", status: "cancelled", created_at: "2026-07-06T10:00:00Z" },
    ],
  });
  const action: ActionParams = { type: "create_return", order_number: "12345" };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("create_replacement — same verification as create_return (both routes write the returns table)", async () => {
  const ctx = makeCtx({
    returns: [
      { id: "r1", ticket_id: "ticket-1", status: "open", created_at: "2026-07-06T10:00:00Z" },
    ],
  });
  const action: ActionParams = { type: "create_replacement", order_number: "12345" };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("create_return — a foreign ticket's return does not verify this ticket's action", async () => {
  const ctx = makeCtx({
    returns: [
      { id: "r-other", ticket_id: "ticket-OTHER", status: "open", created_at: "2026-07-06T10:00:00Z" },
    ],
  });
  const action: ActionParams = { type: "create_return", order_number: "12345" };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

// ── change_next_date ──────────────────────────────────────────────────

test("change_next_date — next_billing_date matches the requested date → verified TRUE", async () => {
  // The named passing state the spec's Verification bullet #2 calls out:
  // the handler succeeded and the mirror column matches the requested
  // date → verifyActionInDB returns true and the response_message ships.
  const ctx = makeCtx({
    subscriptions: [
      { id: "s1", shopify_contract_id: "SC1", next_billing_date: "2026-08-15" },
    ],
  });
  const action: ActionParams = { type: "change_next_date", contract_id: "SC1", date: "2026-08-15" };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("change_next_date — next_billing_date is the WRONG day → verified FALSE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { id: "s1", shopify_contract_id: "SC1", next_billing_date: "2026-09-01" },
    ],
  });
  const action: ActionParams = { type: "change_next_date", contract_id: "SC1", date: "2026-08-15" };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("change_next_date — requested date is in the PAST and next_billing_date is in the future → verified TRUE (order-now fallback)", async () => {
  // The handler's order-now branch: customer said "ship ASAP" so
  // requested date is today/past; the handler triggers a charge now and
  // leaves the next_billing_date to advance on the next successful
  // renewal. As long as next_billing_date is in the future, we treat the
  // action as verified — the customer's intent was satisfied.
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ctx = makeCtx({
    subscriptions: [
      { id: "s1", shopify_contract_id: "SC1", next_billing_date: future },
    ],
  });
  const action: ActionParams = { type: "change_next_date", contract_id: "SC1", date: "2020-01-01" };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

// ── change_frequency ──────────────────────────────────────────────────

test("change_frequency — billing_interval + billing_interval_count both match → verified TRUE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { id: "s1", shopify_contract_id: "SC1", billing_interval: "MONTH", billing_interval_count: 2 },
    ],
  });
  const action: ActionParams = { type: "change_frequency", contract_id: "SC1", interval: "MONTH", interval_count: 2 };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("change_frequency — interval matches case-insensitively (handler emits mixed case)", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { id: "s1", shopify_contract_id: "SC1", billing_interval: "MONTH", billing_interval_count: 1 },
    ],
  });
  const action: ActionParams = { type: "change_frequency", contract_id: "SC1", interval: "month", interval_count: 1 };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("change_frequency — interval_count does NOT match → verified FALSE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { id: "s1", shopify_contract_id: "SC1", billing_interval: "MONTH", billing_interval_count: 1 },
    ],
  });
  const action: ActionParams = { type: "change_frequency", contract_id: "SC1", interval: "MONTH", interval_count: 2 };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("change_frequency — interval does NOT match → verified FALSE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { id: "s1", shopify_contract_id: "SC1", billing_interval: "WEEK", billing_interval_count: 2 },
    ],
  });
  const action: ActionParams = { type: "change_frequency", contract_id: "SC1", interval: "MONTH", interval_count: 2 };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

// ── skip_next_order ───────────────────────────────────────────────────

test("skip_next_order — next_billing_date is in the future → verified TRUE (skip moved the schedule forward)", async () => {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const ctx = makeCtx({
    subscriptions: [
      { id: "s1", shopify_contract_id: "SC1", next_billing_date: future },
    ],
  });
  const action: ActionParams = { type: "skip_next_order", contract_id: "SC1" };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("skip_next_order — next_billing_date is still in the past → verified FALSE (mutation didn't stick)", async () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const ctx = makeCtx({
    subscriptions: [
      { id: "s1", shopify_contract_id: "SC1", next_billing_date: past },
    ],
  });
  const action: ActionParams = { type: "skip_next_order", contract_id: "SC1" };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("skip_next_order — subscription row missing entirely → verified FALSE", async () => {
  const ctx = makeCtx({ subscriptions: [] });
  const action: ActionParams = { type: "skip_next_order", contract_id: "SC1" };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

// ── swap_variant / add_item / remove_item / change_quantity / update_line_item_price ──
// (Phase 2 — item-op + price cases.)
// All read subscriptions.items[] — a jsonb array of { variant_id, quantity, price_cents }
// (see docs/brain/tables/subscriptions.md; there is no standalone subscription_items table).

test("swap_variant — target line's variant_id equals action.new_variant_id → verified TRUE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      {
        id: "s1",
        shopify_contract_id: "SC1",
        items: [{ variant_id: "NEW_V", quantity: 1, price_cents: 3200 }],
      },
    ],
  });
  const action: ActionParams = {
    type: "swap_variant",
    contract_id: "SC1",
    old_variant_id: "OLD_V",
    new_variant_id: "NEW_V",
  };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("swap_variant — HANDLER SAID SUCCESS but subscription_items still points at the OLD variant_id → verified FALSE", async () => {
  // The named failing state the spec's Verification bullet #2 calls out.
  const ctx = makeCtx({
    subscriptions: [
      {
        id: "s1",
        shopify_contract_id: "SC1",
        items: [{ variant_id: "OLD_V", quantity: 1, price_cents: 3200 }],
      },
    ],
  });
  const action: ActionParams = {
    type: "swap_variant",
    contract_id: "SC1",
    old_variant_id: "OLD_V",
    new_variant_id: "NEW_V",
  };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("add_item — a line exists for action.variant_id under the contract → verified TRUE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      {
        id: "s1",
        shopify_contract_id: "SC1",
        items: [{ variant_id: "V123", quantity: 2, price_cents: 4500 }],
      },
    ],
  });
  const action: ActionParams = { type: "add_item", contract_id: "SC1", variant_id: "V123", quantity: 2 };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("add_item — no line matches action.variant_id → verified FALSE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      {
        id: "s1",
        shopify_contract_id: "SC1",
        items: [{ variant_id: "V999", quantity: 1, price_cents: 3200 }],
      },
    ],
  });
  const action: ActionParams = { type: "add_item", contract_id: "SC1", variant_id: "V123", quantity: 1 };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("remove_item — no line for action.variant_id remains → verified TRUE (row is absent)", async () => {
  const ctx = makeCtx({
    subscriptions: [
      {
        id: "s1",
        shopify_contract_id: "SC1",
        items: [{ variant_id: "V_OTHER", quantity: 1, price_cents: 3200 }],
      },
    ],
  });
  const action: ActionParams = { type: "remove_item", contract_id: "SC1", variant_id: "V_GONE" };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("remove_item — HANDLER SAID SUCCESS but the line is still present → verified FALSE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      {
        id: "s1",
        shopify_contract_id: "SC1",
        items: [{ variant_id: "V_STILL", quantity: 1, price_cents: 3200 }],
      },
    ],
  });
  const action: ActionParams = { type: "remove_item", contract_id: "SC1", variant_id: "V_STILL" };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("change_quantity — subscription_items.quantity matches action.quantity → verified TRUE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      {
        id: "s1",
        shopify_contract_id: "SC1",
        items: [{ variant_id: "V1", quantity: 3, price_cents: 3200 }],
      },
    ],
  });
  const action: ActionParams = { type: "change_quantity", contract_id: "SC1", variant_id: "V1", quantity: 3 };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("change_quantity — quantity mismatch → verified FALSE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      {
        id: "s1",
        shopify_contract_id: "SC1",
        items: [{ variant_id: "V1", quantity: 1, price_cents: 3200 }],
      },
    ],
  });
  const action: ActionParams = { type: "change_quantity", contract_id: "SC1", variant_id: "V1", quantity: 3 };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("change_item_quantity — alias name behaves the same as change_quantity", async () => {
  // The spec's Phase-2 bullet names `change_item_quantity`; the live
  // handler dispatch key is `change_quantity`. Both action-type strings
  // land on the same verify case.
  const ctx = makeCtx({
    subscriptions: [
      {
        id: "s1",
        shopify_contract_id: "SC1",
        items: [{ variant_id: "V1", quantity: 4, price_cents: 3200 }],
      },
    ],
  });
  const action: ActionParams = { type: "change_item_quantity", contract_id: "SC1", variant_id: "V1", quantity: 4 };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("update_line_item_price — price_cents on the target line matches action.base_price_cents → verified TRUE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      {
        id: "s1",
        shopify_contract_id: "SC1",
        items: [{ variant_id: "V1", quantity: 1, price_cents: 2500 }],
      },
    ],
  });
  const action: ActionParams = { type: "update_line_item_price", contract_id: "SC1", variant_id: "V1", base_price_cents: 2500 };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("update_line_item_price — price_cents mismatch → verified FALSE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      {
        id: "s1",
        shopify_contract_id: "SC1",
        items: [{ variant_id: "V1", quantity: 1, price_cents: 3200 }],
      },
    ],
  });
  const action: ActionParams = { type: "update_line_item_price", contract_id: "SC1", variant_id: "V1", base_price_cents: 2500 };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

// ── unmapped types fall through (with a WARN) ─────────────────────────

test("unknown/uncovered action type falls through to true AND writes a WARN naming the type (fail-safe pattern)", async () => {
  const warnLog: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: unknown) => { warnLog.push(String(msg)); };
  try {
    const ctx = makeCtx({});
    const action: ActionParams = { type: "some_future_action" };
    assert.equal(await verifyActionInDB(ctx, action), true);
    // A single-line WARN entry naming the uncovered type — the
    // observability handle the spec's Phase-2 bullet names.
    assert.equal(warnLog.length, 1);
    assert.match(warnLog[0], /verifyActionInDB/);
    assert.match(warnLog[0], /some_future_action/);
  } finally {
    console.warn = origWarn;
  }
});
