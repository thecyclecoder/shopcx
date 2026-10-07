/**
 * Phase 1 of cx-agents-read-engine-price-not-override-base.
 *
 * Pins the invariant: for an INTERNAL sub, `getCxSubscriptions` reports the
 * price the renewal engine will ACTUALLY charge — NOT the pre-discount override
 * base. On a 3-bag Cocoa sub carrying `price_override_cents: 7995`, the Cocoa
 * rule's 12% quantity break (at qty 3) × the workspace 25% S&S yields
 * $52.77/bag ($15 8.31/shipment) — that's what agents must see on
 * `item.realized_cents` and on `sub.renewal_subtotal_cents`.
 *
 * Stubs the Supabase admin client via Node's ESM module cache BEFORE dynamic-
 * importing cx-agent-sdk.ts so the SDK + its `resolveSubscriptionPricing` call
 * share one stub.
 *
 * Run:
 *   npx tsx --test src/lib/cx-agent-sdk.subscriptions-engine-price.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const CUSTOMER_ID = "22222222-2222-2222-2222-222222222222";
const SUB_ID = "33333333-3333-3333-3333-333333333333";
const VARIANT_ID = "44444444-4444-4444-4444-444444444444";
const PRODUCT_ID = "55555555-5555-5555-5555-555555555555";
const RULE_ID = "66666666-6666-6666-6666-666666666666";

// Cocoa rule — 12% break at qty 3, 25% S&S.
const world = {
  sub: {
    id: SUB_ID,
    customer_id: CUSTOMER_ID,
    shopify_contract_id: "internal-1682046baaf94689",
    status: "active",
    is_internal: true,
    billing_source: "internal",
    delivery_price_cents: 0,
    pricing_offer_id: null as string | null,
    items: [
      {
        variant_id: VARIANT_ID,
        product_id: PRODUCT_ID,
        title: "Cocoa Superfoods",
        variant_title: "Cocoa",
        quantity: 3,
        price_override_cents: 7995,
      },
    ],
    applied_discounts: null,
    billing_interval: "month",
    billing_interval_count: 1,
    next_billing_date: "2026-11-07",
    created_at: "2026-01-01T00:00:00Z",
  },
  variant: {
    id: VARIANT_ID,
    shopify_variant_id: "999",
    price_cents: 7995,
    product_id: PRODUCT_ID,
  },
  ruleAssign: { product_id: PRODUCT_ID, pricing_rule_id: RULE_ID, workspace_id: WORKSPACE_ID },
  rule: {
    id: RULE_ID,
    subscribe_discount_pct: 25,
    quantity_breaks: [
      { quantity: 2, discount_pct: 8 },
      { quantity: 3, discount_pct: 12 },
    ] as Array<{ quantity: number; discount_pct: number }>,
    free_shipping: false,
    free_shipping_threshold_cents: null,
    free_shipping_subscription_only: null,
    is_active: true,
  },
  workspace: { id: WORKSPACE_ID, subscription_discount_pct: 25 },
};

interface QueryBuilder {
  select(cols: string): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  in(col: string, vals: unknown[]): QueryBuilder;
  or(expr: string): QueryBuilder;
  order(col: string, opts?: unknown): QueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  then<T>(cb: (v: { data: unknown; error: null }) => T): Promise<T>;
}

function makeFrom(table: string): QueryBuilder {
  function resolveMany(): unknown[] {
    switch (table) {
      case "subscriptions":
        return [world.sub];
      case "customer_links":
        return [];
      case "product_variants":
        return [world.variant];
      case "product_pricing_rule":
        return [world.ruleAssign];
      case "pricing_rules":
        return [world.rule];
      case "workspaces":
        return [world.workspace];
      default:
        return [];
    }
  }
  function resolveOne(): unknown {
    if (table === "workspaces") return world.workspace;
    return null;
  }
  const builder: QueryBuilder = {
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    in() {
      return builder;
    },
    or() {
      return builder;
    },
    order() {
      return builder;
    },
    async maybeSingle() {
      return { data: resolveOne(), error: null };
    },
    then<T>(cb: (v: { data: unknown; error: null }) => T): Promise<T> {
      return Promise.resolve(cb({ data: resolveMany(), error: null }));
    },
  };
  return builder;
}

const stubAdmin = {
  from(table: string) {
    return makeFrom(table);
  },
};

// Patch the admin client BEFORE dynamic-importing cx-agent-sdk (and its pricing dep).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};
// customer-links.linkGroupIds returns [customerId] when there is no link group — fine with our
// empty customer_links stub. inventory/read.getAmplifierOnHandBySku and refund-ledger /
// email-typo imports are not touched on the getCxSubscriptions path.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getCxSubscriptions } = require("./cx-agent-sdk") as typeof import("./cx-agent-sdk");

test("Phase 1: internal sub realized_cents is the engine price, NOT the override base ($79.95 base × 3 bags × Cocoa 12% break × 25% S&S → $52.77/bag, renewal $158.31)", async () => {
  const subs = await getCxSubscriptions(stubAdmin as never, WORKSPACE_ID, CUSTOMER_ID);
  assert.equal(subs.length, 1, "one subscription returned");
  const sub = subs[0];
  assert.equal(sub.billing_source, "internal");

  const item = sub.items[0];
  // The bug this phase fixes: realized_cents used to be `price ?? override` → 7995.
  // The engine actually charges 7995 × 0.88 × 0.75 = 5276.7 → 5277 per bag.
  assert.equal(item.realized_cents, 5277, "realized is the engine price (post break + S&S), not the override base");
  assert.equal(item.base_cents, 7995, "base_cents is the pre-discount strike");
  assert.equal(item.break_pct, 12, "break_pct names the 12% Cocoa quantity break");
  assert.equal(item.sns_pct, 25, "sns_pct names the 25% S&S");
  assert.equal(item.is_grandfathered, true, "the override lock flags grandfathered");

  // Σ realized × qty = 5277 × 3 = 15831 — what the renewal will actually charge.
  assert.equal(sub.renewal_subtotal_cents, 15831, "renewal_subtotal_cents is Σ realized × qty");

  // The pre-discount override must still be visible so an agent can reason about the lock,
  // but it must NOT be reported as the realized price.
  assert.equal(item.price_override_cents, 7995);
  assert.notEqual(item.realized_cents, item.price_override_cents);
});

test("Phase 1: external (non-internal) sub leaves realized_cents on the baked price_cents and null-decomposes — we don't own the composition", async () => {
  const originalBillingSource = world.sub.billing_source;
  const originalIsInternal = world.sub.is_internal;
  const originalItems = world.sub.items;
  world.sub.billing_source = "appstle";
  world.sub.is_internal = false;
  world.sub.items = [
    {
      variant_id: VARIANT_ID,
      product_id: PRODUCT_ID,
      title: "Cocoa Superfoods",
      variant_title: "Cocoa",
      quantity: 3,
      // External engine bakes the realized unit in `price_cents` — DO NOT rerun through our engine.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      price_cents: 5277 as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  ];
  try {
    const subs = await getCxSubscriptions(stubAdmin as never, WORKSPACE_ID, CUSTOMER_ID);
    const sub = subs[0];
    assert.equal(sub.billing_source, "appstle");
    assert.equal(sub.items[0].realized_cents, 5277, "realized is the baked price_cents on an external engine");
    assert.equal(sub.items[0].base_cents, null, "no decomposition for external engines");
    assert.equal(sub.renewal_subtotal_cents, null, "renewal subtotal is null — the external engine owns composition");
  } finally {
    world.sub.billing_source = originalBillingSource;
    world.sub.is_internal = originalIsInternal;
    world.sub.items = originalItems;
  }
});
