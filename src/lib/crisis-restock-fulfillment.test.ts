/**
 * Unit coverage for shipRestockPromises — Phase 2 of
 * crisis-resolve-ships-promised-restock-replacements.
 *
 * Pins the two properties the spec names:
 *  - SELECTION: only `status='awaiting_restock'` [[replacements]] rows for THIS
 *    crisis + workspace are shipped (a `created` row, a different-crisis row,
 *    and a different-workspace row are all ignored), and each ships through the
 *    SDK with `existingReplacementId` = the promise row id (row reuse, not a
 *    second row).
 *  - COMPARE-AND-SET: the claim flips the row off `awaiting_restock` before the
 *    Shopify call, so a second Resolve (or a double-click) ships nothing — the
 *    SDK is invoked exactly once across two runs.
 *  - FAILURE: a failed create marks the row `failed`, reopens the ticket, and
 *    raises a fulfillment_alert; the promise lands in `failed`, not `created`.
 *
 * Pure — no live DB, no live Shopify. An in-memory admin fake applies eq
 * filters to update() so the compare-and-set behaves like Postgres (a row whose
 * status already moved does not re-match). The SDK + identity/address resolvers
 * are injected via the deps seam.
 *
 * Run:  npx tsx --test src/lib/crisis-restock-fulfillment.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shipRestockPromises, normalizePromiseItems, type ShipRestockDeps } from "./crisis-restock-fulfillment";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Op { kind: "select" | "update" | "insert"; filters: Array<[string, unknown]>; patch?: Row; insertRow?: Row; head?: boolean }

function makeBuilder(tables: Tables, table: string) {
  const op: Op = { kind: "select", filters: [] };
  const builder: Record<string, unknown> = {
    select(_cols?: unknown, opts?: { head?: boolean }) { if (op.kind !== "update") op.kind = "select"; if (opts?.head) op.head = true; return builder; },
    update(patch: Row) { op.kind = "update"; op.patch = patch; return builder; },
    insert(row: Row) { op.kind = "insert"; op.insertRow = row; return exec(); },
    eq(col: string, val: unknown) { op.filters.push([col, val]); return builder; },
    then(resolve: (r: { data: Row[] | null; error: null; count?: number }) => unknown) { resolve(exec()); },
  };
  function match(r: Row) { return op.filters.every(([c, v]) => r[c] === v); }
  function exec(): { data: Row[] | null; error: null; count?: number } {
    const rows = tables[table] ??= [];
    if (op.kind === "insert") { rows.push(op.insertRow as Row); return { data: [op.insertRow as Row], error: null }; }
    const matched = rows.filter(match);
    if (op.kind === "update") { for (const r of matched) Object.assign(r, op.patch); return { data: matched.map((r) => ({ id: r.id })), error: null }; }
    if (op.head) return { data: null, error: null, count: matched.length };
    return { data: matched, error: null };
  }
  return builder;
}

function makeAdmin(tables: Tables) {
  return { from: (t: string) => makeBuilder(tables, t) } as unknown as Parameters<typeof shipRestockPromises>[0];
}

const WS = "ws-superfoods";
const OTHER_WS = "ws-other";
const CRISIS = "crisis-cocoa";
const OTHER_CRISIS = "crisis-hazelnut";

function makeDeps(over: Partial<ShipRestockDeps> & { tables?: Tables } = {}): ShipRestockDeps {
  const calls: Array<Record<string, unknown>> = [];
  const deps: ShipRestockDeps = {
    resolveShopifyCustomerId: (async () => "ship-cust-1") as ShipRestockDeps["resolveShopifyCustomerId"],
    resolveShippingAddress: (async () => ({
      address: { firstName: "Peggy", lastName: "P", address1: "1 Main", address2: "", city: "Austin", province: "TX", provinceCode: "TX", zip: "78701", countryCode: "US" },
      source: "default_address", diverged: false, citedOrderAddress: null,
    })) as unknown as ShipRestockDeps["resolveShippingAddress"],
    createReplacement: (async (input: { existingReplacementId?: string }) => {
      calls.push(input as Record<string, unknown>);
      // Mimic the SDK reuse path: flip the reused row to created.
      if (over.tables && input.existingReplacementId) {
        const row = (over.tables.replacements || []).find((r) => r.id === input.existingReplacementId);
        if (row) row.status = "created";
      }
      return { success: true, replacementId: input.existingReplacementId || "new", shopifyOrderName: "SC999001" };
    }) as unknown as ShipRestockDeps["createReplacement"],
    ...over,
  };
  (deps as unknown as { _calls: typeof calls })._calls = calls;
  return deps;
}

test("(SELECTION) ships only awaiting_restock rows for this crisis + workspace, reusing each row id", async () => {
  const tables: Tables = {
    replacements: [
      { id: "r-promise", workspace_id: WS, crisis_id: CRISIS, status: "awaiting_restock", customer_id: "c1", ticket_id: "t1", original_order_number: "SC1", items: [{ variantId: "v1", quantity: 2, title: "Cocoa" }] },
      { id: "r-created", workspace_id: WS, crisis_id: CRISIS, status: "created", customer_id: "c2", ticket_id: "t2", original_order_number: null, items: [{ variantId: "v2", quantity: 1, title: "X" }] },
      { id: "r-other-crisis", workspace_id: WS, crisis_id: OTHER_CRISIS, status: "awaiting_restock", customer_id: "c3", ticket_id: null, original_order_number: null, items: [{ variantId: "v3", quantity: 1, title: "Y" }] },
      { id: "r-other-ws", workspace_id: OTHER_WS, crisis_id: CRISIS, status: "awaiting_restock", customer_id: "c4", ticket_id: null, original_order_number: null, items: [{ variantId: "v4", quantity: 1, title: "Z" }] },
    ],
    tickets: [{ id: "t1", workspace_id: WS, status: "closed" }],
    ticket_messages: [],
    dashboard_notifications: [],
  };
  const deps = makeDeps({ tables });
  const res = await shipRestockPromises(makeAdmin(tables), WS, CRISIS, deps);

  assert.equal(res.created.length, 1);
  assert.equal(res.failed.length, 0);
  assert.equal(res.created[0].replacement_id, "r-promise");

  const calls = (deps as unknown as { _calls: Array<{ existingReplacementId?: string }> })._calls;
  assert.equal(calls.length, 1, "exactly one replacement shipped — the single matching promise");
  assert.equal(calls[0].existingReplacementId, "r-promise", "SDK reuses the promise row, not a fresh insert");

  const note = tables.ticket_messages.find((m) => m.ticket_id === "t1");
  assert.ok(note && /Crisis resolved: restock replacement SC999001 created/.test(String(note.body)));
});

test("(COMPARE-AND-SET) a second resolve ships nothing — the SDK fires exactly once across two runs", async () => {
  const tables: Tables = {
    replacements: [
      { id: "r-promise", workspace_id: WS, crisis_id: CRISIS, status: "awaiting_restock", customer_id: "c1", ticket_id: "t1", original_order_number: null, items: [{ variantId: "v1", quantity: 1, title: "Cocoa" }] },
    ],
    tickets: [{ id: "t1", workspace_id: WS, status: "closed" }],
    ticket_messages: [],
    dashboard_notifications: [],
  };
  const deps = makeDeps({ tables });
  const admin = makeAdmin(tables);

  const first = await shipRestockPromises(admin, WS, CRISIS, deps);
  const second = await shipRestockPromises(admin, WS, CRISIS, deps);

  assert.equal(first.created.length, 1);
  assert.equal(second.created.length, 0, "second resolve finds the row already created — nothing to ship");
  assert.equal(tables.replacements[0].status, "created");
  const calls = (deps as unknown as { _calls: unknown[] })._calls;
  assert.equal(calls.length, 1, "no double-ship: createReplacement called once total");
});

test("(FAILURE) a failed create marks the row failed, reopens the ticket, raises a fulfillment_alert", async () => {
  const tables: Tables = {
    replacements: [
      { id: "r-promise", workspace_id: WS, crisis_id: CRISIS, status: "awaiting_restock", customer_id: "c1", ticket_id: "t1", original_order_number: null, items: [{ variantId: "v1", quantity: 1, title: "Cocoa" }] },
    ],
    tickets: [{ id: "t1", workspace_id: WS, status: "closed" }],
    ticket_messages: [],
    dashboard_notifications: [],
  };
  const deps = makeDeps({ tables });
  (deps as ShipRestockDeps).createReplacement = (async () => ({ success: false, replacementId: "r-promise", shopifyOrderName: null, error: "Replacement variant not on Shopify" })) as unknown as ShipRestockDeps["createReplacement"];

  const res = await shipRestockPromises(makeAdmin(tables), WS, CRISIS, deps);

  assert.equal(res.created.length, 0);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].replacement_id, "r-promise");
  assert.equal(tables.replacements[0].status, "failed");
  assert.equal(tables.tickets[0].status, "open", "ticket reopened for a human");
  const alert = tables.dashboard_notifications[0];
  assert.ok(alert, "a dashboard notification was raised");
  assert.equal(alert.type, "fulfillment_alert");
  assert.equal((alert.metadata as { severity?: string }).severity, "high");
});

test("(GUARD) a promise row with no customer_id fails without calling the SDK", async () => {
  const tables: Tables = {
    replacements: [
      { id: "r-promise", workspace_id: WS, crisis_id: CRISIS, status: "awaiting_restock", customer_id: null, ticket_id: null, original_order_number: null, items: [{ variantId: "v1", quantity: 1, title: "Cocoa" }] },
    ],
    tickets: [],
    ticket_messages: [],
    dashboard_notifications: [],
  };
  const deps = makeDeps({ tables });
  const res = await shipRestockPromises(makeAdmin(tables), WS, CRISIS, deps);
  assert.equal(res.failed.length, 1);
  assert.equal((deps as unknown as { _calls: unknown[] })._calls.length, 0, "SDK never called without a customer id");
  assert.equal(tables.replacements[0].status, "failed");
});

test("(PURE) normalizePromiseItems drops empty variant ids and defaults quantity", () => {
  const items = normalizePromiseItems([
    { variantId: "v1", quantity: 3, title: "Cocoa" },
    { variantId: "", quantity: 1, title: "junk" },
    { variantId: "v2", title: "Mango" },
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { variantId: "v1", quantity: 3, title: "Cocoa" });
  assert.equal(items[1].quantity, 1);
});
