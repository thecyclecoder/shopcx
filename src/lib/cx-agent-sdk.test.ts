/**
 * Unit tests for the CX-agent SDK — Phase 1 of docs/brain/specs/cx-box-agents-sol-
 * cora-june-deterministic-sdk-toolset-and-brain-access-no-raw-sql.md.
 *
 * The SDK must be correct BY CONSTRUCTION for the three CX box agents (Sol / Cora /
 * June). Assertions pin the failing state the spec calls out — an improvised SQL
 * lookup that returns empty for a resolvable customer, orders that don't compute
 * per-unit from the actual charged amount, subs that ignore the internal-contract
 * price_override_cents column, and policies loaded from anywhere other than the
 * enabled+approved sonnet_prompts surface.
 *
 * Run: npx tsx --test src/lib/cx-agent-sdk.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getCxCustomer,
  getCxOrders,
  getCxSubscriptions,
  getCxProducts,
  getCxPolicies,
  getCxBundle,
  formatCxBundle,
  runCxSdkVerb,
  isCxSdkVerb,
  CX_SDK_VERBS,
} from "./cx-agent-sdk";

interface Row {
  [k: string]: unknown;
}

interface FakeState {
  customer_links: Row[];
  customers: Row[];
  orders: Row[];
  subscriptions: Row[];
  products: Row[];
  sonnet_prompts: Row[];
}

function makeAdmin(state: FakeState) {
  function makeBuilder(rows: Row[]) {
    const filters: Array<(r: Row) => boolean> = [];
    let selectCols = "*";
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    const b = {
      select(cols: string) {
        selectCols = cols;
        return b;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return b;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return b;
      },
      gte(col: string, val: unknown) {
        filters.push((r) => (r[col] as string) >= (val as string));
        return b;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderBy = { col, asc: opts?.ascending ?? true };
        return b;
      },
      limit(n: number) {
        limitN = n;
        return b;
      },
      maybeSingle() {
        void selectCols;
        const match = rows.find((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: match ?? null, error: null });
      },
      single() {
        const match = rows.find((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: match ?? null, error: null });
      },
      then(resolve: (v: { data: Row[] | null; error: null }) => unknown) {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (orderBy) {
          const { col, asc } = orderBy;
          out = [...out].sort((a, b) => {
            const av = a[col] as string;
            const bv = b[col] as string;
            if (av === bv) return 0;
            return (av < bv ? -1 : 1) * (asc ? 1 : -1);
          });
        }
        if (limitN != null) out = out.slice(0, limitN);
        return Promise.resolve({ data: out, error: null }).then(resolve);
      },
    };
    return b;
  }
  return {
    from(table: string) {
      const rows = (state as unknown as Record<string, Row[]>)[table];
      if (!rows) throw new Error(`unexpected table: ${table}`);
      return makeBuilder(rows);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const WS = "00000000-0000-0000-0000-0000000000ws";
const C1 = "cust-primary";
const C2 = "cust-linked";
const GROUP = "grp-1";

function baseState(): FakeState {
  return {
    customer_links: [
      { workspace_id: WS, customer_id: C1, group_id: GROUP },
      { workspace_id: WS, customer_id: C2, group_id: GROUP },
    ],
    customers: [
      {
        id: C1,
        workspace_id: WS,
        first_name: "Jill",
        last_name: "Smith",
        email: "jill@example.com",
        subscription_status: "active",
        retention_score: 82,
        email_marketing_status: "subscribed",
        sms_marketing_status: "unsubscribed",
        shopify_customer_id: "shopify-99",
      },
    ],
    orders: [],
    subscriptions: [],
    products: [
      {
        id: "prod-acv",
        workspace_id: WS,
        title: "ACV Gummies",
        handle: "acv-gummies",
        status: "active",
        variants: [
          { id: "var-berry", title: "Berry", price_cents: 4995 },
          { id: "var-peach", title: "Peach", price_cents: 4995 },
        ],
      },
      { id: "prod-off", workspace_id: WS, title: "Discontinued", status: "archived", variants: [] },
    ],
    sonnet_prompts: [
      { workspace_id: WS, category: "returns", title: "60-day return", content: "60-day free return.", enabled: true, status: "approved", sort_order: 1 },
      { workspace_id: WS, category: "returns", title: "Disabled", content: "…", enabled: false, status: "approved", sort_order: 2 },
      { workspace_id: WS, category: "returns", title: "Proposed", content: "…", enabled: true, status: "proposed", sort_order: 3 },
    ],
  };
}

test("getCxCustomer surfaces the merged-identity group + primary profile", async () => {
  const admin = makeAdmin(baseState());
  const c = await getCxCustomer(admin, WS, C1);
  assert.equal(c.customer_id, C1);
  assert.deepEqual(new Set(c.linked_customer_ids), new Set([C1, C2]));
  assert.ok(c.profile);
  assert.equal(c.profile!.email, "jill@example.com");
  assert.equal(c.profile!.retention_score, 82);
});

test("getCxCustomer returns [self] when the customer has no link group", async () => {
  const s = baseState();
  s.customer_links = [];
  const admin = makeAdmin(s);
  const c = await getCxCustomer(admin, WS, C1);
  assert.deepEqual(c.linked_customer_ids, [C1]);
});

test("getCxOrders computes per-unit from actual charged line total (not raw price_cents)", async () => {
  const s = baseState();
  s.orders = [
    {
      order_number: "#1001",
      shopify_order_id: "gid://shopify/Order/1",
      workspace_id: WS,
      customer_id: C1,
      // Total $44.74 for 2 units — 22.37/unit — Ticket cd2e4a9a's scenario where
      // Shopify's originalUnitPriceSet reports $22.46/unit (pre-discount).
      total_cents: 4474,
      financial_status: "paid",
      created_at: new Date().toISOString(),
      source_name: "web",
      subscription_id: null,
      payment_details: { subtotal_cents: 4474 },
      line_items: [
        { title: "ACV Gummies", quantity: 2, price_cents: 2246, variant_id: "var-berry" },
      ],
    },
  ];
  const admin = makeAdmin(s);
  const orders = await getCxOrders(admin, WS, C1);
  assert.equal(orders.length, 1);
  const line = orders[0].line_items[0];
  assert.equal(line.per_unit_cents, 2237, "per-unit must be charged-line ÷ qty, not price_cents");
  assert.equal(line.line_total_cents, 4474);
  assert.equal(line.variant_title, "Berry", "variant title must resolve from products.variants[].title");
});

test("getCxOrders fans out across the merged-identity group", async () => {
  const s = baseState();
  s.orders = [
    {
      order_number: "#A",
      workspace_id: WS,
      customer_id: C1,
      total_cents: 100,
      created_at: "2026-06-01T00:00:00Z",
      line_items: [{ title: "x", quantity: 1, price_cents: 100 }],
      payment_details: null,
    },
    {
      order_number: "#B",
      workspace_id: WS,
      customer_id: C2,
      total_cents: 200,
      created_at: "2026-06-05T00:00:00Z",
      line_items: [{ title: "y", quantity: 1, price_cents: 200 }],
      payment_details: null,
    },
  ];
  const admin = makeAdmin(s);
  const orders = await getCxOrders(admin, WS, C1);
  const nums = orders.map((o) => o.order_number).sort();
  assert.deepEqual(nums, ["#A", "#B"], "orders on the linked sibling must be visible");
});

test("getCxSubscriptions surfaces price_override_cents (internal contracts) as realized_cents", async () => {
  const s = baseState();
  s.subscriptions = [
    {
      id: "sub-1",
      workspace_id: WS,
      customer_id: C1,
      shopify_contract_id: null,
      status: "active",
      billing_interval: "MONTH",
      billing_interval_count: 1,
      next_billing_date: "2026-08-01",
      created_at: "2026-01-01T00:00:00Z",
      items: [
        // Internal contract: price_cents is null, realized price is on price_override_cents.
        // The pre-SDK improvised query missed this and rendered "@ $0.00".
        { title: "ACV Gummies", variant_id: "var-berry", variant_title: "Berry", quantity: 1, price_cents: null, price_override_cents: 3745 },
      ],
      applied_discounts: [{ id: "d-1", title: "LOYAL10", type: "percentage", value: 10, valueType: "percentage" }],
    },
  ];
  const admin = makeAdmin(s);
  const subs = await getCxSubscriptions(admin, WS, C1);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].items[0].realized_cents, 3745);
  assert.equal(subs[0].applied_discounts.length, 1);
  assert.equal(subs[0].applied_discounts[0].title, "LOYAL10");
  assert.equal(subs[0].applied_discounts[0].value_type, "percentage", "valueType → value_type mapping");
});

test("getCxProducts only surfaces status='active' rows", async () => {
  const admin = makeAdmin(baseState());
  const products = await getCxProducts(admin, WS);
  assert.equal(products.length, 1);
  assert.equal(products[0].title, "ACV Gummies");
  assert.equal(products[0].variants.length, 2);
});

test("getCxPolicies only surfaces enabled+approved sonnet_prompts", async () => {
  const admin = makeAdmin(baseState());
  const policies = await getCxPolicies(admin, WS);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].title, "60-day return");
});

test("getCxBundle composes all five getters + formatCxBundle produces one text block", async () => {
  const s = baseState();
  s.subscriptions = [
    {
      id: "sub-1",
      workspace_id: WS,
      customer_id: C1,
      status: "active",
      items: [{ title: "ACV", quantity: 1, price_cents: 3745, price_override_cents: null }],
      applied_discounts: [],
      billing_interval: "MONTH",
      billing_interval_count: 1,
      next_billing_date: "2026-08-01",
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  const admin = makeAdmin(s);
  const b = await getCxBundle(admin, WS, C1);
  assert.equal(b.customer_id, C1);
  assert.ok(b.customer);
  assert.equal(b.subscriptions.length, 1);
  assert.equal(b.products.length, 1);
  assert.equal(b.policies.length, 1);
  const txt = formatCxBundle(b);
  assert.match(txt, /CX SDK snapshot/);
  assert.match(txt, /CUSTOMER: Jill Smith/);
  assert.match(txt, /SUBSCRIPTIONS:/);
  assert.match(txt, /PRODUCTS \(active/);
  assert.match(txt, /POLICIES/);
});

test("getCxBundle with null customer_id still returns products + policies", async () => {
  const admin = makeAdmin(baseState());
  const b = await getCxBundle(admin, WS, null);
  assert.equal(b.customer_id, null);
  assert.equal(b.customer, null);
  assert.equal(b.orders.length, 0);
  assert.equal(b.subscriptions.length, 0);
  assert.equal(b.products.length, 1);
  assert.equal(b.policies.length, 1);
});

test("runCxSdkVerb dispatches every named verb", async () => {
  const admin = makeAdmin(baseState());
  for (const verb of CX_SDK_VERBS) {
    assert.ok(isCxSdkVerb(verb));
    const out = await runCxSdkVerb(admin, verb, WS, C1);
    assert.equal(typeof out, "string");
    assert.ok(out.length > 0, `verb ${verb} produced empty output`);
  }
});

test("isCxSdkVerb refuses an unknown verb", () => {
  assert.equal(isCxSdkVerb("customer"), true);
  assert.equal(isCxSdkVerb("drop-table"), false);
});
