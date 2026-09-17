/**
 * Linked-account fixture test for the `create_return` direct-action handler —
 * pins the order-ownership lookup at line ~2643 of action-executor.ts to
 * SPAN the ticket customer's link group via [[customer-links]] `linkGroupIds`.
 *
 * Ground truth (spec: create-return-order-lookup-must-span-linked-accounts,
 * ticket bafa0f7a-447b-4cdf-a44b-f4fca0decce6): a 3+ year customer's
 * `create_return` on SC138373 failed repeatedly with "Order SC138373 not
 * found" because SC138373.customer_id was a linked peer (270c88ba /
 * nataliepalm57@gmail.com) auto-linked from an inline mention, while the
 * ticket's resolved `ctx.customerId` was 827b7894
 * (npsheppard@clinicalconsultants.org). The `.eq("customer_id",
 * ctx.customerId)` filter made the linked-sibling order invisible.
 *
 * The widening uses `.in("customer_id", linkGroupIds(...))` so a linked
 * peer's order counts as owned, while an unrelated workspace customer's
 * order still returns zero rows (the ownership security property).
 *
 * Pure — no live DB, no live Shopify. Uses an in-memory admin fake shaped
 * like supabase-js. The handler dynamically imports @/lib/shopify-returns
 * at entry (the module load is safe — its side effects are lazy) and then
 * uses `ctx.admin` for every read the test needs to observe. Bail early
 * with `shipping_address = null` on the found order so the handler returns
 * "No shipping address on order" BEFORE reaching `createFullReturn` — the
 * lookup outcome is what we pin.
 *
 * Run:  npx tsx --test src/lib/action-executor.create-return-linked-accounts.test.ts
 * (Registered as `test:create-return-linked-accounts` in package.json.)
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
    maybeSingle: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    single: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    // Thenable: `await chain` (no terminal .maybeSingle/.single) resolves to
    // the full row set. Both `create_return`'s HARD-INVARIANT existing-returns
    // read (uses .neq then awaits) and `linkGroupIds`'s peers read (awaits
    // after two .eq's) drive this path.
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
const CUST_TICKET = "cust-npsheppard-827b7894";     // ctx.customerId (npsheppard@clinicalconsultants.org)
const CUST_LINKED = "cust-natalie-270c88ba";        // linked sibling (nataliepalm57@gmail.com) — SC138373 owner
const CUST_UNRELATED = "cust-unrelated";            // same workspace, NOT linked
const LINK_GROUP = "grp-shared-household";
const ORDER_NUMBER = "SC138373";

function baseCtx(): ActionContext {
  return {
    admin: null as unknown as ActionContext["admin"],
    workspaceId: WS,
    ticketId: "tkt-bafa0f7a",
    customerId: CUST_TICKET,
    channel: "email",
    sandbox: false,
  };
}

// ─── FAIL-STATE PIN: the ground-truth failure mode ─────────────────────
// Without the widening, this test asserts the "Order not found" error the
// customer's create_return actually returned — proving the linked-sibling
// order was invisible to the handler. With the widening (this build), the
// same fixture is now resolvable and we get the DIFFERENT downstream
// "No shipping address on order" error, proving the lookup found the order.

test("(LINKED ACCOUNT — ground truth) create_return resolves an order whose customer_id is a linked peer of ctx.customerId", async () => {
  const touched: string[] = [];
  const tables: Tables = {
    // No existing return on this ticket — the HARD-INVARIANT check passes.
    returns: [],
    // The link-group edges — both customers point to the SAME group id.
    customer_links: [
      { workspace_id: WS, customer_id: CUST_TICKET, group_id: LINK_GROUP },
      { workspace_id: WS, customer_id: CUST_LINKED, group_id: LINK_GROUP },
    ],
    // The order sits on the LINKED SIBLING, not on ctx.customerId — the
    // exact shape of ticket bafa0f7a's SC138373.
    orders: [
      {
        id: "ord-sc138373",
        workspace_id: WS,
        customer_id: CUST_LINKED,
        order_number: ORDER_NUMBER,
        shopify_order_id: "5555555",
        // Null shipping_address so the handler returns early with "No
        // shipping address on order" AFTER finding the order but BEFORE
        // calling createFullReturn. That's exactly the lookup outcome
        // we're pinning.
        shipping_address: null,
      },
    ],
    customers: [
      { id: CUST_TICKET, first_name: "N", last_name: "Sheppard" },
    ],
  };
  const ctx = { ...baseCtx(), admin: makeAdmin(tables, touched) };
  const p: ActionParams = { type: "create_return", order_number: ORDER_NUMBER };
  const result = await directActionHandlers.create_return(ctx, p);

  // The order WAS found — we did NOT get the "Order not found" error the
  // ticket saw. That's the ground-truth fix.
  assert.notEqual(
    result.error,
    `Order ${ORDER_NUMBER} not found`,
    "The linked-sibling's order must be found via linkGroupIds — an 'Order not found' error here means the widening regressed and the ticket bafa0f7a failure mode is back.",
  );
  // And we DID reach the downstream shipping-address check — proving the
  // lookup returned the order row itself.
  assert.equal(
    result.error,
    "No shipping address on order",
    "Handler must have proceeded past the order lookup to the shipping-address check.",
  );
  assert.equal(result.success, false);

  // Grep-verifiable side-check: the customer_links + orders tables were
  // both read — the widening's linkGroupIds call fires before the order
  // filter.
  assert.ok(touched.includes("customer_links"), "linkGroupIds must have consulted customer_links");
  assert.ok(touched.includes("orders"), "handler must have consulted orders");
});

// ─── OWNERSHIP PROPERTY PRESERVED ──────────────────────────────────────
// An order owned by a workspace customer who is NOT in the ticket
// customer's link group must still be invisible — a foreign order number
// can't smuggle a return-label + refund exposure onto an unrelated
// customer's order.

test("(OWNERSHIP PRESERVED) create_return refuses an order that belongs to an unrelated workspace customer NOT in the ticket customer's link group", async () => {
  const touched: string[] = [];
  const tables: Tables = {
    returns: [],
    // ctx.customerId is not in any link group.
    customer_links: [],
    orders: [
      {
        id: "ord-not-yours",
        workspace_id: WS,
        customer_id: CUST_UNRELATED, // ← NOT linked to CUST_TICKET
        order_number: ORDER_NUMBER,
        shopify_order_id: "9999999",
        shipping_address: { address1: "1 Any St", city: "Nowhere", state: "CA", zip: "94000" },
      },
    ],
    customers: [{ id: CUST_TICKET, first_name: "N", last_name: "Sheppard" }],
  };
  const ctx = { ...baseCtx(), admin: makeAdmin(tables, touched) };
  const p: ActionParams = { type: "create_return", order_number: ORDER_NUMBER };
  const result = await directActionHandlers.create_return(ctx, p);

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    `Order ${ORDER_NUMBER} not found`,
    "Ownership property: an order owned by an unrelated workspace customer must still return 'not found' — the widening must not expand to arbitrary same-workspace orders.",
  );
});

// ─── UNLINKED CUSTOMER STILL WORKS ─────────────────────────────────────
// A customer with no link-group row is not a special case — linkGroupIds
// returns `[ctx.customerId]` so the behavior is identical to the
// pre-widening `.eq("customer_id", ctx.customerId)` filter.

test("(UNLINKED) create_return still resolves the ticket customer's own order when the customer has no link group — no regression on the common case", async () => {
  const touched: string[] = [];
  const tables: Tables = {
    returns: [],
    customer_links: [],
    orders: [
      {
        id: "ord-own",
        workspace_id: WS,
        customer_id: CUST_TICKET,
        order_number: ORDER_NUMBER,
        shopify_order_id: "1234567",
        shipping_address: null,
      },
    ],
    customers: [{ id: CUST_TICKET, first_name: "N", last_name: "Sheppard" }],
  };
  const ctx = { ...baseCtx(), admin: makeAdmin(tables, touched) };
  const p: ActionParams = { type: "create_return", order_number: ORDER_NUMBER };
  const result = await directActionHandlers.create_return(ctx, p);

  assert.notEqual(result.error, `Order ${ORDER_NUMBER} not found`);
  assert.equal(result.error, "No shipping address on order");
  assert.equal(result.success, false);
});

// ─── HANDLER WIRING PIN (grep-verifiable) ──────────────────────────────
// A future edit that reintroduces `.eq("customer_id", ctx.customerId)` in
// the create_return handler bypasses the widening — pin the presence of
// `.in("customer_id", ...)` and the absence of the narrow filter.

test("the handler's source uses `.in(\"customer_id\", linkGroupIds(...))` on the orders lookup — never a narrow `.eq(\"customer_id\", ctx.customerId)` again", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./action-executor.ts", import.meta.url), "utf8");
  const handlerStart = src.indexOf("create_return: async");
  assert.notEqual(handlerStart, -1, "create_return handler must exist");
  const handlerBody = src.slice(handlerStart, src.indexOf("partial_refund:", handlerStart));
  assert.match(
    handlerBody,
    /linkGroupIds\s*\(\s*admin\s*,\s*ctx\.workspaceId\s*,\s*ctx\.customerId\s*\)/,
    "create_return handler must resolve link-group ids via `linkGroupIds(admin, ctx.workspaceId, ctx.customerId)` before the orders lookup.",
  );
  assert.match(
    handlerBody,
    /\.in\(\s*"customer_id"\s*,\s*ownerIds\s*\)/,
    "create_return handler's orders lookup must filter with `.in(\"customer_id\", ownerIds)` — the widening line.",
  );
  assert.doesNotMatch(
    handlerBody,
    /\.eq\(\s*"customer_id"\s*,\s*ctx\.customerId\s*\)/,
    "create_return handler must never regress to `.eq(\"customer_id\", ctx.customerId)` on the orders lookup — that is exactly the ticket bafa0f7a failure mode.",
  );
});
