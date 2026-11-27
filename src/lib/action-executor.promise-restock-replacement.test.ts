/**
 * Unit coverage for the `promise_restock_replacement` direct-action handler —
 * Phase 1 of crisis-resolve-ships-promised-restock-replacements.
 *
 * Ground truth: support promises a customer with NO subscription (Peggy,
 * customer 0897b4e5) that we'll send their out-of-stock flavor when it's back.
 * Resolving a crisis only touches subscriptions, so that promise previously
 * lived only as a snoozed ticket a human had to remember. This handler records
 * the promise structurally into `replacements` with status='awaiting_restock'
 * against the crisis — and creates NO Shopify order. Phase 2 ships every
 * awaiting_restock row on crisis resolve.
 *
 * These tests pin the NAMED correct states:
 *  - missing variant_id is rejected (empty promise never recorded)
 *  - the per-variant cap (REPLACEMENT_MAX_UNITS_PER_VARIANT=4) is enforced
 *    BEFORE any row is inserted
 *  - a promise with no matching active crisis is rejected
 *  - the happy path inserts exactly one awaiting_restock row carrying crisis_id,
 *    customer_id, ticket_id, the canonical items shape, and reason=
 *    'crisis_restock_promise', and writes the internal ticket note — with NO
 *    Shopify replacement order created.
 *
 * Pure — no live DB, no live Shopify. In-memory admin fake shaped like
 * supabase-js with insert support.
 *
 * Run:  npx tsx --test src/lib/action-executor.promise-restock-replacement.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { directActionHandlers, type ActionContext, type ActionParams } from "./action-executor";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
interface Filter { col: string; val: unknown }

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => row[f.col] === f.val);
}

function makeChain(tables: Tables, table: string, inserted: Row[]) {
  const filters: Filter[] = [];
  let pendingInsert: Row | null = null;
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (col: string, val: unknown) => { filters.push({ col, val }); return chain },
    order: () => chain,
    limit: () => chain,
    insert: (payload: Row) => { pendingInsert = payload; (tables[table] ??= []).push(payload); inserted.push({ __table: table, ...payload }); return chain },
    maybeSingle: async () => {
      if (pendingInsert) return { data: { id: `row-${inserted.length}`, ...pendingInsert }, error: null };
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    single: async () => {
      if (pendingInsert) return { data: { id: `row-${inserted.length}`, ...pendingInsert }, error: null };
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
  };
  return chain;
}

function makeAdmin(tables: Tables, inserted: Row[]) {
  return { from: (t: string) => makeChain(tables, t, inserted) } as unknown as ActionContext["admin"];
}

const WS = "ws-superfoods";
const CUST = "cust-peggy-0897b4e5";
const TICKET = "tkt-restock-promise";
const VARIANT = "42614433513645"; // out-of-stock Cocoa variant
const CRISIS = "crisis-cocoa-oos";

function baseCtx(admin: ActionContext["admin"]): ActionContext {
  return { admin, workspaceId: WS, ticketId: TICKET, customerId: CUST, channel: "email", sandbox: false };
}

function activeCrisisTables(): Tables {
  return {
    crisis_events: [
      { id: CRISIS, workspace_id: WS, status: "active", affected_variant_id: VARIANT, affected_product_title: "Cocoa", expected_restock_date: "2026-12-15" },
    ],
    product_variants: [],
    replacements: [],
    ticket_messages: [],
  };
}

test("(REJECT) promise_restock_replacement without variant_id records nothing", async () => {
  const inserted: Row[] = [];
  const ctx = baseCtx(makeAdmin(activeCrisisTables(), inserted));
  const p: ActionParams = { type: "promise_restock_replacement", quantity: 1 };
  const r = await directActionHandlers.promise_restock_replacement(ctx, p);
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /variant_id/);
  assert.equal(inserted.length, 0, "no replacements row may be inserted when variant_id is missing");
});

test("(CAP) promise_restock_replacement over the per-variant cap is rejected before any insert", async () => {
  const inserted: Row[] = [];
  const ctx = baseCtx(makeAdmin(activeCrisisTables(), inserted));
  const p: ActionParams = { type: "promise_restock_replacement", variant_id: VARIANT, quantity: 5 };
  const r = await directActionHandlers.promise_restock_replacement(ctx, p);
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /cap/i);
  assert.equal(inserted.filter((x) => x.__table === "replacements").length, 0, "over-cap promise must not insert a replacements row");
});

test("(NO CRISIS) promise_restock_replacement with no matching active crisis is rejected", async () => {
  const inserted: Row[] = [];
  const tables: Tables = { crisis_events: [], product_variants: [], replacements: [], ticket_messages: [] };
  const ctx = baseCtx(makeAdmin(tables, inserted));
  const p: ActionParams = { type: "promise_restock_replacement", variant_id: VARIANT, quantity: 1 };
  const r = await directActionHandlers.promise_restock_replacement(ctx, p);
  assert.equal(r.success, false);
  assert.match(r.error ?? "", /no active crisis/i);
  assert.equal(inserted.length, 0);
});

test("(HAPPY) promise_restock_replacement records one awaiting_restock row + internal note, no Shopify order", async () => {
  const inserted: Row[] = [];
  const tables = activeCrisisTables();
  const ctx = baseCtx(makeAdmin(tables, inserted));
  const p: ActionParams = { type: "promise_restock_replacement", variant_id: VARIANT, quantity: 2, original_order_number: "SC140001", reason_detail: "promised Cocoa on restock" };
  const r = await directActionHandlers.promise_restock_replacement(ctx, p);

  assert.equal(r.success, true, r.error);

  const rows = inserted.filter((x) => x.__table === "replacements");
  assert.equal(rows.length, 1, "exactly one replacements row recorded");
  const row = rows[0];
  assert.equal(row.status, "awaiting_restock");
  assert.equal(row.crisis_id, CRISIS);
  assert.equal(row.customer_id, CUST);
  assert.equal(row.ticket_id, TICKET);
  assert.equal(row.reason, "crisis_restock_promise");
  assert.equal(row.original_order_number, "SC140001");
  const items = row.items as Array<{ variantId: string; quantity: number; title: string }>;
  assert.equal(items.length, 1);
  assert.equal(items[0].variantId, VARIANT);
  assert.equal(items[0].quantity, 2);

  const notes = inserted.filter((x) => x.__table === "ticket_messages");
  assert.equal(notes.length, 1, "one internal ticket note written");
  assert.equal(notes[0].visibility, "internal");
  assert.match(String(notes[0].body), /Recorded restock promise/);

  // No Shopify replacement order: the only replacements row is the promise,
  // and it carries no shopify_replacement_order_name.
  assert.equal((row as Row).shopify_replacement_order_name, undefined);
});
