/**
 * Phase 1 of subscription-renewals-must-honor-free-shipping-guarantee.
 *
 * Pins the invariant the phase restores in `resolveSubscriptionPricing`:
 * the WORKSPACE-level subscription free-shipping GUARANTEE
 * (`workspaces.subscription_free_shipping`, surfaced to the AI as the
 * `subs.free_shipping` rule) zeroes renewal shipping on EVERY internal
 * subscription order — even when no per-product `pricing_rules.free_shipping`
 * rule grants it.
 *
 * The bug (ticket 00618fac): the resolver only consulted
 * `pricing_rules.free_shipping`, so a workspace that guaranteed free shipping
 * on all subs but had no per-product free-shipping rule charged
 * `delivery_price_cents` ($4.95) on every renewal. CS Director June refunded
 * it three cycles in a row and it recurred on the fourth.
 *
 * Stubs the Supabase admin client via Node's ESM module cache BEFORE dynamic-
 * importing pricing.ts (same harness as pricing.grandfathered.test.ts). The
 * `world.workspace` object is swapped per-case so each test controls the
 * workspace flags the engine reads.
 *
 * Run:
 *   npx tsx --test src/lib/pricing.freeship-guarantee.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const VARIANT_ID = "22222222-2222-2222-2222-222222222222";
const PRODUCT_ID = "33333333-3333-3333-3333-333333333333";
const RULE_ID = "44444444-4444-4444-4444-444444444444";

const world = {
  variant: {
    id: VARIANT_ID,
    shopify_variant_id: "999",
    price_cents: 6100,
    product_id: PRODUCT_ID,
  },
  ruleAssign: { product_id: PRODUCT_ID, pricing_rule_id: RULE_ID, workspace_id: WORKSPACE_ID },
  rule: {
    id: RULE_ID,
    subscribe_discount_pct: 25,
    quantity_breaks: null as null | Array<{ quantity: number; discount_pct: number }>,
    // The gap: NO per-product free-shipping rule — the only free-shipping grant
    // is the workspace guarantee below.
    free_shipping: false,
    free_shipping_threshold_cents: null,
    free_shipping_subscription_only: null,
    is_active: true,
  },
  // Swapped per test.
  workspace: {
    id: WORKSPACE_ID,
    subscription_discount_pct: 25,
    subscription_free_shipping: false as boolean | null,
    subscription_free_shipping_threshold_cents: null as number | null,
  },
};

interface QueryBuilder {
  select(cols: string): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  in(col: string, vals: unknown[]): QueryBuilder;
  or(expr: string): QueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  then<T>(cb: (v: { data: unknown; error: null }) => T): Promise<T>;
}

function makeFrom(table: string): QueryBuilder {
  function resolve(): unknown {
    switch (table) {
      case "product_variants":
        return [world.variant];
      case "product_pricing_rule":
        return [world.ruleAssign];
      case "pricing_rules":
        return [world.rule];
      case "workspaces":
        return world.workspace;
      case "pricing_rule_offers":
        return null;
      default:
        return null;
    }
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
    async maybeSingle() {
      const r = resolve();
      if (Array.isArray(r)) return { data: r[0] ?? null, error: null };
      return { data: r ?? null, error: null };
    },
    then<T>(cb: (v: { data: unknown; error: null }) => T): Promise<T> {
      const r = resolve();
      const data = Array.isArray(r) ? r : r ? [r] : [];
      return Promise.resolve(cb({ data, error: null }));
    },
  };
  return builder;
}

const stubAdmin = { from(table: string) { return makeFrom(table); } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveSubscriptionPricing } = require("./pricing") as typeof import("./pricing");

function subWithShipping(deliveryCents: number) {
  return {
    items: [
      {
        variant_id: VARIANT_ID,
        product_id: PRODUCT_ID,
        title: "Immunity Superfoods",
        quantity: 1,
      },
    ],
    delivery_price_cents: deliveryCents,
  };
}

test("workspace subscription_free_shipping=true zeroes renewal shipping with NO per-product free-ship rule (ticket 00618fac)", async () => {
  world.workspace = {
    id: WORKSPACE_ID,
    subscription_discount_pct: 25,
    subscription_free_shipping: true,
    subscription_free_shipping_threshold_cents: null, // guarantee with no minimum
  };
  const pricing = await resolveSubscriptionPricing(WORKSPACE_ID, subWithShipping(495));
  assert.equal(pricing.shipping_cents, 0, "guarantee zeroes the $4.95 delivery charge");
  assert.equal(pricing.free_shipping, true, "free_shipping flag reflects the guarantee");
  assert.ok(pricing.discounts.some((d) => d.kind === "free_shipping"), "free-shipping pill present");
});

test("workspace guarantee OFF keeps the sub's locked delivery_price_cents (unchanged behavior)", async () => {
  world.workspace = {
    id: WORKSPACE_ID,
    subscription_discount_pct: 25,
    subscription_free_shipping: false,
    subscription_free_shipping_threshold_cents: null,
  };
  const pricing = await resolveSubscriptionPricing(WORKSPACE_ID, subWithShipping(495));
  assert.equal(pricing.shipping_cents, 495, "no grant → shipping is charged");
  assert.equal(pricing.free_shipping, false);
});

test("workspace guarantee with a threshold the subtotal does NOT clear still charges shipping", async () => {
  world.workspace = {
    id: WORKSPACE_ID,
    subscription_discount_pct: 25,
    subscription_free_shipping: true,
    // Subtotal is 6100 × 0.75 = 4575; threshold 10000 is not cleared.
    subscription_free_shipping_threshold_cents: 10000,
  };
  const pricing = await resolveSubscriptionPricing(WORKSPACE_ID, subWithShipping(495));
  assert.equal(pricing.shipping_cents, 495, "below threshold → shipping is charged");
  assert.equal(pricing.free_shipping, false);
});

test("workspace guarantee with a threshold the subtotal clears grants free shipping", async () => {
  world.workspace = {
    id: WORKSPACE_ID,
    subscription_discount_pct: 25,
    subscription_free_shipping: true,
    subscription_free_shipping_threshold_cents: 4000, // 4575 subtotal clears it
  };
  const pricing = await resolveSubscriptionPricing(WORKSPACE_ID, subWithShipping(495));
  assert.equal(pricing.shipping_cents, 0, "at/above threshold → free shipping");
  assert.equal(pricing.free_shipping, true);
});
