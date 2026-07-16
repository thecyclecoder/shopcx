/**
 * orders-classification — Phase 1 + Phase 2 verification.
 *
 * Phase 1 fixture-pins classifyOrder against a curated row-set spanning all
 * three sources × renewal/checkout × sub/one_time, and grep-guards that the
 * SDK still delegates the renewal/subscription predicate to bucketOrder.
 *
 * Phase 2 pins queryOrders against a seeded fake admin: origin/renewal filter,
 * customerRecency first-vs-repeat with renewals counted, lastDays / since /
 * until bounds, and a >1000-row pagination proof.
 *
 * The spec suggests vitest; the repo's convention is node:test via tsx:
 *   npx tsx --test src/lib/orders-classification.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import { classifyOrder, queryOrders, type OrderRow } from "./orders-classification";

// ── source × origin × cartType fixture table ──
// Each row is a real-shaped orders slice; the expected verdict is what the
// callers currently hand-roll (or should — the whole point of the SDK).

type Fixture = {
  name: string;
  row: Parameters<typeof classifyOrder>[0];
  expected: ReturnType<typeof classifyOrder>;
};

const FIXTURES: Fixture[] = [
  // ── SHOPIFY ──
  {
    name: "shopify subscription renewal (subscription_contract)",
    row: { source_name: "subscription_contract", shopify_order_id: "5555555555" },
    expected: { source: "shopify", origin: "renewal", cartType: undefined },
  },
  {
    name: "shopify subscription renewal (subscription_contract_checkout_one)",
    row: { source_name: "subscription_contract_checkout_one", shopify_order_id: "5555555556" },
    expected: { source: "shopify", origin: "renewal", cartType: undefined },
  },
  {
    name: "shopify checkout that created a subscription (first-subscription tag)",
    row: {
      source_name: "web",
      shopify_order_id: "5555555557",
      tags: "first subscription, foo",
      subscription_id: "sub-abc",
    },
    expected: { source: "shopify", origin: "checkout", cartType: "subscription" },
  },
  {
    name: "shopify one-time checkout (web, no sub tag)",
    row: { source_name: "web", shopify_order_id: "5555555558", tags: "loyalty" },
    expected: { source: "shopify", origin: "checkout", cartType: "one_time" },
  },
  {
    name: "shopify draft/replacement order",
    row: { source_name: "shopify_draft_order", shopify_order_id: "5555555559" },
    expected: { source: "shopify", origin: "checkout", cartType: undefined },
  },

  // ── INTERNAL ──
  {
    name: "internal subscription renewal (internal_subscription_renewal → renewal)",
    row: {
      source_name: "internal_subscription_renewal",
      braintree_transaction_id: "bt-txn-1",
      subscription_id: "sub-int-1",
    },
    expected: { source: "internal", origin: "renewal", cartType: undefined },
  },
  {
    name: "internal comp renewal (internal_subscription_comp_renewal → renewal)",
    row: {
      source_name: "internal_subscription_comp_renewal",
      subscription_id: "sub-int-2",
    },
    expected: { source: "internal", origin: "renewal", cartType: undefined },
  },
  {
    name: "internal storefront one-time (bare storefront order → checkout/one_time)",
    row: { source_name: "storefront" },
    expected: { source: "internal", origin: "checkout", cartType: "one_time" },
  },
  {
    name: "internal storefront checkout that joined a sub (subscription_id set)",
    row: { source_name: "storefront", subscription_id: "sub-int-3" },
    expected: { source: "internal", origin: "checkout", cartType: "subscription" },
  },
  {
    name: "internal fallback — braintree charge, no shopify_order_id, no source_name",
    row: { braintree_transaction_id: "bt-txn-2" },
    expected: { source: "internal", origin: "checkout", cartType: "one_time" },
  },

  // ── AMAZON ──
  {
    name: "amazon one-time checkout (source_name=amazon)",
    row: { source_name: "amazon", amazon_order_id: "111-1111111-1111111" },
    expected: { source: "amazon", origin: "checkout", cartType: "one_time" },
  },
  {
    name: "amazon by amazon_order_id alone",
    row: { amazon_order_id: "111-2222222-2222222" },
    expected: { source: "amazon", origin: "checkout", cartType: "one_time" },
  },
];

for (const fx of FIXTURES) {
  test(`classifyOrder — ${fx.name}`, () => {
    const got = classifyOrder(fx.row);
    assert.equal(got.source, fx.expected.source, "source");
    assert.equal(got.origin, fx.expected.origin, "origin");
    assert.equal(got.cartType, fx.expected.cartType, "cartType");
    // Phase 1: customerRecency is always undefined — Phase 2 fills it.
    assert.equal(got.customerRecency, undefined, "customerRecency (Phase 1 always undefined)");
  });
}

test("customerRecency is never populated by classifyOrder (checkout OR renewal)", () => {
  // classifyOrder alone has no DB access; queryOrders is what fills it.
  const rows: Parameters<typeof classifyOrder>[0][] = [
    { source_name: "web", shopify_order_id: "1" },
    { source_name: "storefront" },
    { source_name: "internal_subscription_renewal" },
    { source_name: "amazon" },
  ];
  for (const r of rows) {
    assert.equal(classifyOrder(r).customerRecency, undefined);
  }
});

test("respects workspaces.order_source_mapping (passes through to bucketOrder)", () => {
  // A workspace can map a custom source_name to "recurring" or "replacement".
  const mapping = { my_custom_renewal: "recurring", my_custom_draft: "replacement" };
  assert.equal(
    classifyOrder({ source_name: "my_custom_renewal" }, { sourceMapping: mapping }).origin,
    "renewal",
  );
  assert.equal(
    classifyOrder({ source_name: "my_custom_draft" }, { sourceMapping: mapping }).cartType,
    undefined,
  );
});

// ── grep guards: reuse bucketOrder, never re-derive the renewal predicate ──

const SDK_SOURCE = fs.readFileSync(
  path.join(__dirname, "orders-classification.ts"),
  "utf8",
);

test("orders-classification.ts imports bucketOrder from ./order-bucketing (no re-implementation)", () => {
  // Must delegate origin/cartType to the SoT classifier.
  assert.match(
    SDK_SOURCE,
    /from\s+["']\.\/order-bucketing["']/,
    "orders-classification.ts must import from ./order-bucketing",
  );
  assert.match(
    SDK_SOURCE,
    /\bbucketOrder\b/,
    "orders-classification.ts must call bucketOrder",
  );
});

test("orders-classification.ts contains no inline `source_name.includes(\"subscription\")` re-derivation", () => {
  // Anyone re-implementing bucketOrder's renewal predicate here would drift
  // ROAS silently — the grep guard fails the build on it.
  assert.doesNotMatch(
    SDK_SOURCE,
    /source_name\s*(?:\?\.)?\s*\.\s*includes\s*\(\s*["']subscription["']\s*\)/,
    "orders-classification.ts must delegate to bucketOrder — no inline subscription re-derivation",
  );
});

// ── Phase 2 — queryOrders against a seeded fake admin ──

const WS = "ws-phase2";
const OTHER_WS = "ws-other";

/**
 * Seeded orders row shape. Matches the columns queryOrders selects.
 */
interface SeedOrder {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  order_number: string | null;
  email: string | null;
  total_cents: number;
  source_name: string | null;
  tags: string | string[] | null;
  shopify_order_id: string | null;
  braintree_transaction_id: string | null;
  amplifier_order_id: string | null;
  amazon_order_id: string | null;
  created_at: string;
}

/**
 * Filter descriptor collected during a fake-admin chain — replayed to filter
 * the seeded rows when the query is awaited.
 */
type FilterOp =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "in"; col: string; values: unknown[] }
  | { kind: "gte"; col: string; val: string }
  | { kind: "lte"; col: string; val: string }
  | { kind: "cursor-desc"; createdAt: string; id: string } // .or('created_at.lt.X,and(created_at.eq.X,id.lt.Y)')
  | { kind: "cursor-asc"; createdAt: string; id: string };  // .or('created_at.gt.X,and(created_at.eq.X,id.gt.Y)')

interface OrderClause {
  col: string;
  ascending: boolean;
}

/**
 * Build a fake SupabaseClient over an in-memory orders table. Only implements
 * the subset queryOrders uses (from/select/eq/in/gte/lte/or/order/limit +
 * thenable). Faithful to PostgREST semantics for the cursor `.or()` clauses.
 */
function makeFakeAdmin(seed: SeedOrder[]): SupabaseClient {
  const table = seed.slice();

  const admin = {
    from(name: string) {
      assert.equal(name, "orders", "queryOrders must only read the orders table");
      const filters: FilterOp[] = [];
      const orders: OrderClause[] = [];
      let limit = Number.POSITIVE_INFINITY;

      const chain: Record<string, unknown> = {};
      chain.select = (_cols: string) => chain;
      chain.eq = (col: string, val: unknown) => {
        filters.push({ kind: "eq", col, val });
        return chain;
      };
      chain.in = (col: string, values: unknown[]) => {
        filters.push({ kind: "in", col, values });
        return chain;
      };
      chain.gte = (col: string, val: string) => {
        filters.push({ kind: "gte", col, val });
        return chain;
      };
      chain.lte = (col: string, val: string) => {
        filters.push({ kind: "lte", col, val });
        return chain;
      };
      chain.or = (clause: string) => {
        // Parse exactly the two cursor shapes queryOrders emits:
        //   descending  : "created_at.lt.<ISO>,and(created_at.eq.<ISO>,id.lt.<id>)"
        //   ascending   : "created_at.gt.<ISO>,and(created_at.eq.<ISO>,id.gt.<id>)"
        const desc = clause.match(
          /^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/,
        );
        if (desc) {
          filters.push({ kind: "cursor-desc", createdAt: desc[1], id: desc[3] });
          return chain;
        }
        const asc = clause.match(
          /^created_at\.gt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.gt\.([^)]+)\)$/,
        );
        if (asc) {
          filters.push({ kind: "cursor-asc", createdAt: asc[1], id: asc[3] });
          return chain;
        }
        throw new Error(`fake admin: unrecognised .or() clause: ${clause}`);
      };
      chain.order = (col: string, opts: { ascending: boolean }) => {
        orders.push({ col, ascending: !!opts.ascending });
        return chain;
      };
      chain.limit = (n: number) => {
        limit = n;
        return chain;
      };
      chain.then = (
        onFulfilled: (v: { data: SeedOrder[]; error: null }) => unknown,
      ) => {
        let rows = table.slice();
        for (const f of filters) {
          if (f.kind === "eq") {
            rows = rows.filter(
              (r) => (r as unknown as Record<string, unknown>)[f.col] === f.val,
            );
          } else if (f.kind === "in") {
            const set = new Set(f.values);
            rows = rows.filter((r) =>
              set.has((r as unknown as Record<string, unknown>)[f.col]),
            );
          } else if (f.kind === "gte") {
            rows = rows.filter(
              (r) => String((r as unknown as Record<string, unknown>)[f.col]) >= f.val,
            );
          } else if (f.kind === "lte") {
            rows = rows.filter(
              (r) => String((r as unknown as Record<string, unknown>)[f.col]) <= f.val,
            );
          } else if (f.kind === "cursor-desc") {
            rows = rows.filter(
              (r) =>
                r.created_at < f.createdAt ||
                (r.created_at === f.createdAt && r.id < f.id),
            );
          } else if (f.kind === "cursor-asc") {
            rows = rows.filter(
              (r) =>
                r.created_at > f.createdAt ||
                (r.created_at === f.createdAt && r.id > f.id),
            );
          }
        }
        for (let i = orders.length - 1; i >= 0; i--) {
          const { col, ascending } = orders[i];
          rows.sort((a, b) => {
            const av = (a as unknown as Record<string, unknown>)[col] as string | number;
            const bv = (b as unknown as Record<string, unknown>)[col] as string | number;
            if (av === bv) return 0;
            const cmp = av < bv ? -1 : 1;
            return ascending ? cmp : -cmp;
          });
        }
        if (Number.isFinite(limit)) rows = rows.slice(0, limit);
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return admin;
}

// ── canonical seeded set ──

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

const BASE: Omit<SeedOrder, "id" | "created_at" | "customer_id" | "source_name"> = {
  workspace_id: WS,
  subscription_id: null,
  order_number: null,
  email: null,
  total_cents: 1000,
  tags: null,
  shopify_order_id: null,
  braintree_transaction_id: null,
  amplifier_order_id: null,
  amazon_order_id: null,
};

// Customer A: two Shopify checkouts (1st ever = 60d ago, 2nd = 10d ago) + 1 renewal 5d ago
// Customer B: single Shopify checkout 3d ago (first-time)
// Customer C: internal storefront checkout 60d ago (out of 30d window) + internal renewal 2d ago
// Customer D (other workspace): should be excluded

const SEED: SeedOrder[] = [
  {
    ...BASE,
    id: "ord-a-1",
    customer_id: "cust-a",
    source_name: "web",
    shopify_order_id: "9000000001",
    created_at: iso(60),
  },
  {
    ...BASE,
    id: "ord-a-2",
    customer_id: "cust-a",
    source_name: "web",
    shopify_order_id: "9000000002",
    created_at: iso(10),
  },
  {
    ...BASE,
    id: "ord-a-3",
    customer_id: "cust-a",
    source_name: "subscription_contract",
    shopify_order_id: "9000000003",
    subscription_id: "sub-a",
    created_at: iso(5),
  },
  {
    ...BASE,
    id: "ord-b-1",
    customer_id: "cust-b",
    source_name: "web",
    shopify_order_id: "9000000004",
    created_at: iso(3),
  },
  {
    ...BASE,
    id: "ord-c-1",
    customer_id: "cust-c",
    source_name: "storefront",
    created_at: iso(60),
  },
  {
    ...BASE,
    id: "ord-c-2",
    customer_id: "cust-c",
    source_name: "internal_subscription_renewal",
    subscription_id: "sub-c",
    braintree_transaction_id: "bt-c-2",
    created_at: iso(2),
  },
  {
    ...BASE,
    id: "ord-d-1",
    workspace_id: OTHER_WS,
    customer_id: "cust-d",
    source_name: "web",
    shopify_order_id: "9000000005",
    created_at: iso(1),
  },
];

test("queryOrders({origin:'renewal'}) returns only recurring rows", async () => {
  const admin = makeFakeAdmin(SEED);
  const rows = await queryOrders(WS, { origin: "renewal" }, { admin });
  const ids = rows.map((r: OrderRow) => r.id).sort();
  assert.deepEqual(ids, ["ord-a-3", "ord-c-2"], "only the two renewal rows in WS");
  for (const r of rows) {
    assert.equal(r.classification.origin, "renewal");
    assert.equal(r.classification.cartType, undefined);
    // Renewals never carry customerRecency — checkout-only facet.
    assert.equal(r.classification.customerRecency, undefined);
  }
});

test("queryOrders scopes to workspace_id — other workspaces are excluded", async () => {
  const admin = makeFakeAdmin(SEED);
  const rows = await queryOrders(WS, {}, { admin });
  assert.equal(
    rows.some((r) => r.id === "ord-d-1"),
    false,
    "OTHER_WS row must not appear in WS results",
  );
});

test("queryOrders({customerRecency:'first_time'}) excludes any customer with a prior order (renewal counted)", async () => {
  const admin = makeFakeAdmin(SEED);
  // Cover all time so renewal-earlier and checkout-earlier orders are visible.
  const rows = await queryOrders(WS, { customerRecency: "first_time" }, { admin });
  const ids = new Set(rows.map((r) => r.id));

  // ord-a-1 is cust-a's earliest → first_time ✅
  assert.ok(ids.has("ord-a-1"), "customer-a's earliest checkout is first_time");
  // ord-a-2 is a 2nd checkout for cust-a → repeat ❌
  assert.ok(!ids.has("ord-a-2"), "customer-a's 2nd checkout must NOT be first_time");
  // ord-b-1 is cust-b's only order → first_time ✅
  assert.ok(ids.has("ord-b-1"), "customer-b's sole checkout is first_time");
  // ord-c-1 is cust-c's earliest checkout → first_time ✅ (renewal is 58d later)
  assert.ok(ids.has("ord-c-1"), "customer-c's earliest checkout is first_time");
  // Renewals (ord-a-3, ord-c-2) never carry customerRecency → excluded by the filter
  assert.ok(!ids.has("ord-a-3"), "renewal has no customerRecency, must be excluded");
  assert.ok(!ids.has("ord-c-2"), "renewal has no customerRecency, must be excluded");
});

test("queryOrders({customerRecency:'repeat'}) — a customer with a PRIOR renewal makes the next checkout repeat", async () => {
  // Seed: cust-x has a renewal 90d ago + a checkout 5d ago. The renewal is
  // earliest overall, so the checkout MUST classify as repeat (renewals
  // counted per the accepted convention).
  const seed: SeedOrder[] = [
    {
      ...BASE,
      id: "ord-x-1",
      customer_id: "cust-x",
      source_name: "subscription_contract",
      subscription_id: "sub-x",
      shopify_order_id: "9100000001",
      created_at: iso(90),
    },
    {
      ...BASE,
      id: "ord-x-2",
      customer_id: "cust-x",
      source_name: "web",
      shopify_order_id: "9100000002",
      created_at: iso(5),
    },
  ];
  const admin = makeFakeAdmin(seed);
  const rows = await queryOrders(WS, { origin: "checkout" }, { admin });
  const row = rows.find((r) => r.id === "ord-x-2");
  assert.ok(row, "checkout row present");
  assert.equal(
    row!.classification.customerRecency,
    "repeat",
    "prior renewal counts against first-time convention",
  );
});

test("queryOrders({lastDays:N}) bounds results by created_at", async () => {
  const admin = makeFakeAdmin(SEED);
  const last7 = await queryOrders(WS, { lastDays: 7 }, { admin });
  const ids = new Set(last7.map((r) => r.id));
  // 60d and 10d rows fall outside a 7d window.
  assert.ok(!ids.has("ord-a-1"), "60d-old row must be excluded from lastDays=7");
  assert.ok(!ids.has("ord-a-2"), "10d-old row must be excluded from lastDays=7");
  assert.ok(!ids.has("ord-c-1"), "60d-old internal row must be excluded from lastDays=7");
  // 5d, 3d, 2d rows fall inside a 7d window.
  assert.ok(ids.has("ord-a-3"));
  assert.ok(ids.has("ord-b-1"));
  assert.ok(ids.has("ord-c-2"));
});

test("queryOrders({since, until}) bounds results by created_at", async () => {
  const admin = makeFakeAdmin(SEED);
  const since = iso(20);
  const until = iso(4);
  const rows = await queryOrders(WS, { since, until }, { admin });
  const ids = new Set(rows.map((r) => r.id));
  // Only orders with 4d <= age <= 20d qualify — that's ord-a-2 (10d) and ord-a-3 (5d).
  assert.ok(ids.has("ord-a-2"));
  assert.ok(ids.has("ord-a-3"));
  assert.ok(!ids.has("ord-a-1"), "60d row is out of window");
  assert.ok(!ids.has("ord-b-1"), "3d row is more recent than until");
  assert.ok(!ids.has("ord-c-1"), "60d row is out of window");
  assert.ok(!ids.has("ord-c-2"), "2d row is more recent than until");
});

test("queryOrders paginates past the 1000-row cap — >1000 rows are NOT truncated", async () => {
  // A single customer with 1500 orders. queryOrders must return all 1500.
  const seed: SeedOrder[] = [];
  const baseMs = Date.parse(iso(1)); // recent → within default queries
  for (let i = 0; i < 1500; i++) {
    seed.push({
      ...BASE,
      id: `ord-bulk-${String(i).padStart(4, "0")}`,
      customer_id: "cust-bulk",
      source_name: "web",
      shopify_order_id: `95${String(i).padStart(8, "0")}`,
      // Distinct created_at so the cursor advances cleanly.
      created_at: new Date(baseMs - i * 60_000).toISOString(),
    });
  }
  const admin = makeFakeAdmin(seed);
  const rows = await queryOrders(WS, {}, { admin });
  assert.equal(rows.length, 1500, "all 1500 rows must be returned — no silent truncation");
  const uniqIds = new Set(rows.map((r) => r.id));
  assert.equal(uniqIds.size, 1500, "no duplicates from cursor overlap");
});

test("queryOrders composes filters (AND) — origin=checkout AND source=internal", async () => {
  const admin = makeFakeAdmin(SEED);
  const rows = await queryOrders(WS, { origin: "checkout", source: "internal" }, { admin });
  const ids = new Set(rows.map((r) => r.id));
  assert.deepEqual([...ids].sort(), ["ord-c-1"], "only the internal storefront checkout matches");
});

test("queryOrders({source:['shopify','internal']}) accepts an array", async () => {
  const admin = makeFakeAdmin(SEED);
  const rows = await queryOrders(WS, { source: ["shopify", "internal"] }, { admin });
  for (const r of rows) {
    assert.ok(
      r.classification.source === "shopify" || r.classification.source === "internal",
      `source ${r.classification.source} must be one of the requested`,
    );
  }
  // ord-d-1 is OTHER_WS → still excluded by workspace scope.
  assert.ok(!rows.some((r) => r.id === "ord-d-1"));
});
