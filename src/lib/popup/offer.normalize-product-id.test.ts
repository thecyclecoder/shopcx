/**
 * Pins the popup-offer product-reference normalization boundary.
 *
 * The storefront popup passes the product ref as either the internal UUID or a
 * legacy Shopify numeric id. Downstream queries all hit UUID columns
 * (product_pricing_rule.product_id, product_variants.product_id), so a numeric
 * id would trigger Postgres 22P02 and silently drop the value stack.
 *
 * The invariant this test locks in: computePopupOffer normalizes the incoming
 * ref BEFORE any UUID-column query — a numeric Shopify id resolves through
 * products.shopify_product_id, and any unresolvable non-UUID fails closed
 * (returns null) with NO product_pricing_rule / product_variants read.
 *
 * Run:
 *   npx tsx --test src/lib/popup/offer.normalize-product-id.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const INTERNAL_PRODUCT_ID = "22222222-2222-2222-2222-222222222222";
const SHOPIFY_PRODUCT_ID = "8887776665554";
const RULE_ID = "33333333-3333-3333-3333-333333333333";

interface EqCall {
  table: string;
  col: string;
  val: unknown;
}

const world = {
  eqCalls: [] as EqCall[],
  productRow: null as null | { id: string },
  ruleAssignment: { pricing_rule_id: RULE_ID },
  pricingRule: {
    quantity_breaks: [{ quantity: 3, discount_pct: 12 }],
    subscribe_discount_pct: 25,
    free_shipping: true,
    free_gift_variant_id: null as string | null,
    free_gift_product_title: null as string | null,
  },
  variantRow: { price_cents: 6100, compare_at_price_cents: null as number | null },
};

interface QueryBuilder {
  table: string;
  eqs: EqCall[];
  select(_cols: string): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  order(_col: string, _opts: unknown): QueryBuilder;
  limit(_n: number): QueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
}

function makeFrom(table: string): QueryBuilder {
  const eqs: EqCall[] = [];
  const builder: QueryBuilder = {
    table,
    eqs,
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      const call = { table, col, val };
      eqs.push(call);
      world.eqCalls.push(call);
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    async maybeSingle() {
      switch (table) {
        case "products":
          return { data: world.productRow, error: null };
        case "product_pricing_rule":
          return { data: world.ruleAssignment, error: null };
        case "pricing_rules":
          return { data: world.pricingRule, error: null };
        case "product_variants":
          return { data: world.variantRow, error: null };
        default:
          return { data: null, error: null };
      }
    },
  };
  return builder;
}

const stubAdmin = {
  from(table: string) {
    return makeFrom(table);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};
// Bypass findVariant's live Supabase read — no free_gift_variant_id is set in
// the world, so the offer path never calls it, but the module still imports.
moduleAny._cache[require.resolve("@/lib/product-variants")] = {
  exports: { findVariant: async () => null },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { computePopupOffer } = require("./offer") as typeof import("./offer");

function reset(): void {
  world.eqCalls = [];
  world.productRow = null;
}

test("numeric Shopify product id resolves to internal UUID BEFORE any product_pricing_rule / product_variants query", async () => {
  reset();
  world.productRow = { id: INTERNAL_PRODUCT_ID };

  const offer = await computePopupOffer(WORKSPACE_ID, SHOPIFY_PRODUCT_ID);

  assert.ok(offer, "offer returned (numeric id normalized, downstream queries succeeded)");

  const productsLookup = world.eqCalls.find(
    (c) => c.table === "products" && c.col === "shopify_product_id",
  );
  assert.ok(productsLookup, "products.shopify_product_id resolver ran");
  assert.equal(productsLookup!.val, SHOPIFY_PRODUCT_ID);

  const pricingBinds = world.eqCalls.filter(
    (c) => c.table === "product_pricing_rule" && c.col === "product_id",
  );
  assert.equal(pricingBinds.length, 1, "product_pricing_rule.product_id bound exactly once");
  assert.equal(
    pricingBinds[0].val,
    INTERNAL_PRODUCT_ID,
    "product_pricing_rule.product_id bound to resolved UUID — never the raw Shopify id",
  );

  const variantBinds = world.eqCalls.filter(
    (c) => c.table === "product_variants" && c.col === "product_id",
  );
  assert.equal(variantBinds.length, 1);
  assert.equal(
    variantBinds[0].val,
    INTERNAL_PRODUCT_ID,
    "product_variants.product_id bound to resolved UUID — never the raw Shopify id",
  );
});

test("numeric Shopify id with no matching product row FAILS CLOSED — no product_pricing_rule / product_variants query fires", async () => {
  reset();
  world.productRow = null;

  const offer = await computePopupOffer(WORKSPACE_ID, SHOPIFY_PRODUCT_ID);

  assert.equal(offer, null, "unresolvable numeric id yields no offer");
  assert.equal(
    world.eqCalls.filter((c) => c.table === "product_pricing_rule").length,
    0,
    "product_pricing_rule never queried when the ref cannot be normalized",
  );
  assert.equal(
    world.eqCalls.filter((c) => c.table === "product_variants").length,
    0,
    "product_variants never queried when the ref cannot be normalized",
  );
});

test("non-UUID, non-numeric ref fails closed with ZERO Supabase queries", async () => {
  reset();
  const offer = await computePopupOffer(WORKSPACE_ID, "gid://shopify/Product/8887776665554");
  assert.equal(offer, null);
  assert.equal(world.eqCalls.length, 0, "no query ever fires — the resolver rejects before any read");
});

test("internal product UUID passes through untouched — no products.shopify_product_id lookup", async () => {
  reset();

  const offer = await computePopupOffer(WORKSPACE_ID, INTERNAL_PRODUCT_ID);
  assert.ok(offer, "offer returned via the UUID passthrough path");

  assert.equal(
    world.eqCalls.filter((c) => c.table === "products").length,
    0,
    "products table is not touched when the caller already has the UUID",
  );

  const pricingBind = world.eqCalls.find(
    (c) => c.table === "product_pricing_rule" && c.col === "product_id",
  );
  assert.equal(pricingBind!.val, INTERNAL_PRODUCT_ID);
});
