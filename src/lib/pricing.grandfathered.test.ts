/**
 * Phase 1 of subscription-renewal-honors-configured-grandfathered-price-never-
 * bills-standard.
 *
 * Pins the invariant the phase restores in `resolveSubscriptionPricing`:
 *
 *   1. A sub whose item is configured at price_cents=3995 ($39.95/unit) renews
 *      at $39.95/unit — NOT the current catalog standard, even when the catalog
 *      variant price is materially higher and a subscribe & save rule is active.
 *   2. A sub whose item has price_override_cents set (the pre-discount
 *      grandfathered base) still gets S&S applied on top — unchanged behavior.
 *   3. A sub whose item has NEITHER lock is priced live from the catalog + rule
 *      (the default derivation path is preserved).
 *
 * Stubs the Supabase admin client via Node's ESM module cache BEFORE dynamic-
 * importing pricing.ts. The stub answers only the four table reads the engine
 * issues (product_variants, product_pricing_rule, pricing_rules, workspaces —
 * pricing_rule_offers is never queried here because no pricing_offer_id is set).
 *
 * Run:
 *   npx tsx --test src/lib/pricing.grandfathered.test.ts
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
    price_cents: 6100, // catalog MSRP is $61.00 — materially above the sub's locked $39.95
    product_id: PRODUCT_ID,
  },
  ruleAssign: { product_id: PRODUCT_ID, pricing_rule_id: RULE_ID, workspace_id: WORKSPACE_ID },
  rule: {
    id: RULE_ID,
    subscribe_discount_pct: 25, // active S&S — the standard-repricing bug's amplifier
    quantity_breaks: null as null | Array<{ quantity: number; discount_pct: number }>,
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

test("Phase 1: sub's configured line price_cents=3995 renews at $39.95 — the catalog + S&S never re-price a grandfathered lock", async () => {
  const sub = {
    items: [
      {
        variant_id: VARIANT_ID,
        product_id: PRODUCT_ID,
        title: "Immunity Superfoods",
        variant_title: "Vanilla",
        quantity: 1,
        price_cents: 3995,
      },
    ],
    delivery_price_cents: 0,
  };

  const pricing = await resolveSubscriptionPricing(WORKSPACE_ID, sub);

  const line = pricing.lines.find((l) => l.kind === "product");
  assert.ok(line, "product line resolved");
  // The bug shape: engine used to reprice as 6100 × 0.75 = 4575 (or similar w/ break),
  // silently overcharging a customer whose sub is configured at $39.95.
  assert.equal(line!.unit_cents, 3995, "unit is the configured grandfathered rate");
  assert.equal(pricing.product_subtotal_cents, 3995, "subtotal reflects the locked unit");
  assert.equal(line!.is_grandfathered, true, "flagged as grandfathered — strike > unit");
});

test("Phase 1: price_override_cents still applies S&S on top — the existing pre-discount grandfathered base path is preserved", async () => {
  const sub = {
    items: [
      {
        variant_id: VARIANT_ID,
        product_id: PRODUCT_ID,
        title: "Immunity Superfoods",
        quantity: 1,
        // Locked base 5327 -> with 25% S&S -> 3995 charged
        price_override_cents: 5327,
      },
    ],
    delivery_price_cents: 0,
  };

  const pricing = await resolveSubscriptionPricing(WORKSPACE_ID, sub);
  const line = pricing.lines.find((l) => l.kind === "product");
  assert.ok(line, "product line resolved");
  assert.equal(line!.base_cents, 5327);
  assert.equal(line!.unit_cents, Math.round(5327 * 0.75));
  assert.equal(line!.sns_pct, 25);
  assert.equal(line!.is_grandfathered, true);
});

test("Phase 1: sub with NEITHER lock (no price_cents, no override) still prices live off the catalog + rule", async () => {
  const sub = {
    items: [
      {
        variant_id: VARIANT_ID,
        product_id: PRODUCT_ID,
        title: "Immunity Superfoods",
        quantity: 1,
        // no baked price + no override — the default derived path
      },
    ],
    delivery_price_cents: 0,
  };

  const pricing = await resolveSubscriptionPricing(WORKSPACE_ID, sub);
  const line = pricing.lines.find((l) => l.kind === "product");
  assert.ok(line, "product line resolved");
  assert.equal(line!.base_cents, 6100, "base is the catalog MSRP");
  assert.equal(line!.unit_cents, Math.round(6100 * 0.75), "S&S applied off catalog");
  assert.equal(line!.sns_pct, 25);
  assert.equal(line!.is_grandfathered, false);
});
