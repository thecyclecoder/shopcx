/**
 * Linked-account fixture test for the `create_replacement_order` /
 * `dollar_replacement` / `switch_payment_method` direct-action handlers —
 * pins their Shopify-customer-id resolution to SPAN the ticket customer's
 * link group via [[customer-links]] `linkGroupIds` (helper
 * `resolveGroupShopifyCustomerId` in action-executor.ts).
 *
 * Ground truth (spec:
 * create_replacement_order-dollar_replacement-switch_payment_method-must-resolve-shopify-id-across-linked-accounts,
 * ticket ab664ee7-65bc-4c1d-9e34-ff6e14d02dc5): an in-policy never-received
 * replacement (SC141203, Hazelnut substitute for OOS Cocoa) could not execute
 * — create_replacement_order returned "No Shopify customer ID" because
 * ctx.customerId was the ticket profile tiffany@dccpasfirm.com (d2baa618,
 * shopify_customer_id NULL) while the Shopify identity lived on the already-
 * linked sibling tcornwell2001@yahoo.com (aee8bd3f, shopify_customer_id
 * 7060558217389). The three handlers resolved shopify_customer_id from
 * `.eq("id", ctx.customerId)` alone, with no linked-sibling fallback — the
 * identical ownership blind spot create_return already fixed by widening to
 * the link group.
 *
 * The fix resolves across `linkGroupIds`: prefer the ticket customer's own
 * shopify_customer_id, else the first linked sibling that carries one. When
 * no member of the group has one, the "No Shopify customer ID" refusal still
 * fires (fail-closed). An unlinked customer keeps the exact pre-fallback
 * behavior because `linkGroupIds` returns `[ctx.customerId]`.
 *
 * Pure — no live DB, no live Shopify. Uses an in-memory admin fake shaped
 * like supabase-js. `create_replacement_order` is the handler driven at
 * runtime: once the Shopify id is resolved it falls into
 * `resolveCustomerShippingAddress`, which with no address on file returns
 * "No shipping address found on any subscription or order" — a clean early
 * bail AFTER the id resolution, so the resolution outcome is what we pin.
 * The other two handlers (which hit live Shopify once past the id gate) are
 * pinned by the static source checks at the bottom.
 *
 * Run:  npx tsx --test src/lib/action-executor.replacement-shopify-id-linked-accounts.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { directActionHandlers, type ActionContext, type ActionParams } from "./action-executor";

// ── In-memory fake admin ──────────────────────────────────────────────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
interface Filter { col: string; val: unknown; op: "eq" | "in" | "neq" }

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    const v = row[f.col];
    if (f.op === "eq") { if (v !== f.val) return false; continue }
    if (f.op === "neq") { if (v === f.val) return false; continue }
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
  neq: (col: string, val: unknown) => FakeChain;
  in: (col: string, vals: unknown[]) => FakeChain;
  order: (...args: unknown[]) => FakeChain;
  limit: (...args: unknown[]) => FakeChain;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  single: () => Promise<{ data: Row | null; error: null }>;
  then: (
    resolve: (r: { data: Row[]; error: null }) => unknown,
    reject?: (err: unknown) => unknown,
  ) => void;
}

function makeChain(tables: Tables, table: string): FakeChain {
  const filters: Filter[] = [];
  const chain: FakeChain = {
    select: () => chain,
    eq: (col, val) => { filters.push({ col, val, op: "eq" }); return chain },
    neq: (col, val) => { filters.push({ col, val, op: "neq" }); return chain },
    in: (col, vals) => { filters.push({ col, val: vals, op: "in" }); return chain },
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    single: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    then: (resolve, reject) => {
      try {
        const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
        resolve({ data: rows, error: null });
      } catch (err) {
        if (reject) reject(err); else throw err;
      }
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
const CUST_TICKET = "cust-tiffany-d2baa618";    // ctx.customerId — shopify_customer_id NULL
const CUST_LINKED = "cust-tcornwell-aee8bd3f";   // linked sibling — carries the Shopify id
const LINK_GROUP = "grp-cornwell-household";
const SIBLING_SHOPIFY_ID = "7060558217389";
const NO_ADDRESS_ERROR = "No shipping address found on any subscription or order";
const NO_ID_ERROR = "No Shopify customer ID";

function baseCtx(): ActionContext {
  return {
    admin: null as unknown as ActionContext["admin"],
    workspaceId: WS,
    ticketId: "tkt-ab664ee7",
    customerId: CUST_TICKET,
    channel: "email",
    sandbox: false,
  };
}

// ─── FAIL-STATE PIN: the ground-truth failure mode ─────────────────────
// Without the fallback, create_replacement_order returns "No Shopify
// customer ID" because the ticket profile's shopify_customer_id is null.
// With the fallback (this build), the id resolves off the linked sibling
// and the handler proceeds past the id gate to the shipping-address
// resolver, where (no address on file) it bails with the DIFFERENT
// "No shipping address found…" error — proving the id resolved.

test("(LINKED ACCOUNT — ground truth) create_replacement_order resolves shopify_customer_id off a linked sibling when ctx.customerId's is null", async () => {
  const touched: string[] = [];
  const tables: Tables = {
    customer_links: [
      { workspace_id: WS, customer_id: CUST_TICKET, group_id: LINK_GROUP },
      { workspace_id: WS, customer_id: CUST_LINKED, group_id: LINK_GROUP },
    ],
    customers: [
      { id: CUST_TICKET, workspace_id: WS, shopify_customer_id: null, default_address: null },
      { id: CUST_LINKED, workspace_id: WS, shopify_customer_id: SIBLING_SHOPIFY_ID, default_address: null },
    ],
    subscriptions: [],
    orders: [],
  };
  const ctx = { ...baseCtx(), admin: makeAdmin(tables, touched) };
  const p: ActionParams = { type: "create_replacement_order", variant_id: "gid://shopify/ProductVariant/1" };
  const result = await directActionHandlers.create_replacement_order(ctx, p);

  assert.notEqual(
    result.error,
    NO_ID_ERROR,
    "The linked sibling's shopify_customer_id must be used — a 'No Shopify customer ID' error here means the link-group fallback regressed and the ticket ab664ee7 failure mode is back.",
  );
  assert.equal(
    result.error,
    NO_ADDRESS_ERROR,
    "Handler must have proceeded past the shopify-id gate to the shipping-address resolver.",
  );
  assert.equal(result.success, false);
  assert.ok(touched.includes("customer_links"), "linkGroupIds must have consulted customer_links");
});

// ─── FAIL-CLOSED: no identity anywhere in the group ────────────────────
// If NO member of the link group has a shopify_customer_id, the refusal
// must still fire — the fallback must not fabricate an id.

test("(FAIL-CLOSED) create_replacement_order still refuses when no member of the link group has a shopify_customer_id", async () => {
  const touched: string[] = [];
  const tables: Tables = {
    customer_links: [
      { workspace_id: WS, customer_id: CUST_TICKET, group_id: LINK_GROUP },
      { workspace_id: WS, customer_id: CUST_LINKED, group_id: LINK_GROUP },
    ],
    customers: [
      { id: CUST_TICKET, workspace_id: WS, shopify_customer_id: null, default_address: null },
      { id: CUST_LINKED, workspace_id: WS, shopify_customer_id: null, default_address: null },
    ],
    subscriptions: [],
    orders: [],
  };
  const ctx = { ...baseCtx(), admin: makeAdmin(tables, touched) };
  const p: ActionParams = { type: "create_replacement_order", variant_id: "gid://shopify/ProductVariant/1" };
  const result = await directActionHandlers.create_replacement_order(ctx, p);

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    NO_ID_ERROR,
    "With no shopify_customer_id anywhere in the group the handler must fail closed with 'No Shopify customer ID'.",
  );
});

// ─── UNLINKED CUSTOMER STILL WORKS ─────────────────────────────────────
// A customer with their OWN shopify_customer_id and no link group is the
// common case — linkGroupIds returns `[ctx.customerId]`, so the own id is
// used and the handler proceeds exactly as before.

test("(UNLINKED) create_replacement_order uses the ticket customer's own shopify_customer_id — no regression on the common case", async () => {
  const touched: string[] = [];
  const tables: Tables = {
    customer_links: [],
    customers: [
      { id: CUST_TICKET, workspace_id: WS, shopify_customer_id: "8888888888", default_address: null },
    ],
    subscriptions: [],
    orders: [],
  };
  const ctx = { ...baseCtx(), admin: makeAdmin(tables, touched) };
  const p: ActionParams = { type: "create_replacement_order", variant_id: "gid://shopify/ProductVariant/1" };
  const result = await directActionHandlers.create_replacement_order(ctx, p);

  assert.notEqual(result.error, NO_ID_ERROR);
  assert.equal(result.error, NO_ADDRESS_ERROR);
  assert.equal(result.success, false);
});

// ─── HANDLER WIRING PIN (grep-verifiable) ──────────────────────────────
// All three handlers must resolve the Shopify id through the link-group
// helper. A future edit that reverts any of them to the narrow
// `.eq("id", ctx.customerId).single()` read bypasses the fallback.

test("the three handlers resolve shopify_customer_id via `resolveGroupShopifyCustomerId` (link-group spanning), never a narrow own-only read", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./action-executor.ts", import.meta.url), "utf8");

  // The helper exists and spans the group via linkGroupIds.
  const helperStart = src.indexOf("async function resolveGroupShopifyCustomerId");
  assert.notEqual(helperStart, -1, "resolveGroupShopifyCustomerId helper must exist");
  const helperBody = src.slice(helperStart, helperStart + 1200);
  assert.match(
    helperBody,
    /linkGroupIds\s*\(\s*admin\s*,\s*workspaceId\s*,\s*customerId\s*\)/,
    "resolveGroupShopifyCustomerId must widen through linkGroupIds.",
  );

  for (const handler of ["create_replacement_order", "dollar_replacement", "switch_payment_method"]) {
    const start = src.indexOf(`${handler}: async`);
    assert.notEqual(start, -1, `${handler} handler must exist`);
    // Slice to the next handler declaration (`  <name>: async`) so each body
    // is isolated.
    const rest = src.slice(start + handler.length);
    const nextIdx = rest.search(/\n  [a-z_]+: async/);
    const body = rest.slice(0, nextIdx === -1 ? rest.length : nextIdx);
    assert.match(
      body,
      /resolveGroupShopifyCustomerId\s*\(\s*ctx\.admin\s*,\s*ctx\.workspaceId\s*,\s*ctx\.customerId\s*\)/,
      `${handler} must resolve the Shopify id via resolveGroupShopifyCustomerId(ctx.admin, ctx.workspaceId, ctx.customerId).`,
    );
    assert.doesNotMatch(
      body,
      /\.select\("shopify_customer_id"\)\.eq\("id", ctx\.customerId\)\.single\(\)/,
      `${handler} must not regress to the narrow own-only shopify_customer_id read — that is the ticket ab664ee7 failure mode.`,
    );
  }
});
