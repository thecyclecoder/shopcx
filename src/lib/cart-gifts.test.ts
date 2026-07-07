/**
 * Phase 2 of offer-creator — cart-attach invariants.
 *
 * Pins the three concrete failing states the spec's verification names:
 *   1. A physical offer include comes out with a real sku (Amplifier will
 *      fulfill it because the checkout route's `filter((l) => l.sku)`
 *      keeps it).
 *   2. A digital offer include comes out with NO sku (Amplifier's sku
 *      filter drops it) AND carries a `digital_good_id` so the
 *      `orders/created` Inngest digital-goods-delivery function emails
 *      the asset.
 *   3. When the offer's `overrides_pricing_rule_gifts=true`, the
 *      pricing-rule free_gift for that variant's product is skipped —
 *      the offer's included items are the replacement.
 *
 * Stubs the Supabase admin client + findVariant + the offers SDK via
 * Node's ESM module cache BEFORE dynamic-importing cart-gifts.
 *
 * Run:
 *   npx tsx --test src/lib/cart-gifts.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const ANCHOR_VARIANT_ID = "22222222-2222-2222-2222-222222222222";
const ANCHOR_PRODUCT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PHYSICAL_VARIANT_ID = "33333333-3333-3333-3333-333333333333";
const PHYSICAL_PRODUCT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DIGITAL_GOOD_ID = "44444444-4444-4444-4444-444444444444";
const RULE_GIFT_VARIANT_ID = "55555555-5555-5555-5555-555555555555";
const RULE_GIFT_PRODUCT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PRICING_RULE_ID = "66666666-6666-6666-6666-666666666666";

interface OfferRow {
  id: string;
  workspace_id: string;
  variant_id: string;
  name: string | null;
  included: Array<{ ref_id: string; kind: "physical" | "digital"; quantity: number }>;
  scope: string;
  overrides_pricing_rule_gifts: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface WorldState {
  offers: OfferRow[];
  productPricingRule: Array<{ product_id: string; pricing_rule_id: string }>;
  pricingRules: Array<{
    id: string;
    free_gift_variant_id: string | null;
    free_gift_min_quantity: number;
    free_gift_subscription_only: boolean;
    free_gift_image_url: string | null;
    free_gift_product_title: string | null;
  }>;
  digitalGoods: Array<{ id: string; name: string; type: string }>;
  products: Record<string, { title: string; image_url: string | null }>;
}

const world: WorldState = {
  offers: [],
  productPricingRule: [],
  pricingRules: [],
  digitalGoods: [],
  products: {},
};

function resetWorld() {
  world.offers = [];
  world.productPricingRule = [];
  world.pricingRules = [];
  world.digitalGoods = [];
  world.products = {
    [ANCHOR_PRODUCT_ID]: { title: "Anchor Product", image_url: null },
    [PHYSICAL_PRODUCT_ID]: { title: "Bonus Frother", image_url: null },
    [RULE_GIFT_PRODUCT_ID]: { title: "Free Gift Product", image_url: null },
  };
}

const variants: Record<
  string,
  {
    id: string;
    product_id: string;
    shopify_variant_id: string | null;
    sku: string | null;
    title: string | null;
    image_url: string | null;
    price_cents: number;
  }
> = {
  [ANCHOR_VARIANT_ID]: {
    id: ANCHOR_VARIANT_ID,
    product_id: ANCHOR_PRODUCT_ID,
    shopify_variant_id: null,
    sku: "SKU-ANCHOR",
    title: null,
    image_url: null,
    price_cents: 4995,
  },
  [PHYSICAL_VARIANT_ID]: {
    id: PHYSICAL_VARIANT_ID,
    product_id: PHYSICAL_PRODUCT_ID,
    shopify_variant_id: null,
    sku: "SKU-FROTHER",
    title: null,
    image_url: null,
    price_cents: 1500,
  },
  [RULE_GIFT_VARIANT_ID]: {
    id: RULE_GIFT_VARIANT_ID,
    product_id: RULE_GIFT_PRODUCT_ID,
    shopify_variant_id: null,
    sku: "SKU-RULE-GIFT",
    title: null,
    image_url: null,
    price_cents: 800,
  },
};

interface QueryBuilder {
  select(cols: string): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  in(col: string, vals: unknown[]): QueryBuilder;
  order(col: string, opts?: unknown): QueryBuilder;
  limit(n: number): QueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  single(): Promise<{ data: unknown; error: null }>;
  then<T>(cb: (v: { data: unknown; error: null }) => T): Promise<T>;
}

function makeFrom(table: string): QueryBuilder {
  const filters: Record<string, unknown> = {};
  const inFilters: Record<string, unknown[]> = {};

  function resolve(): unknown {
    if (table === "offers") {
      let rows = world.offers.slice();
      if (filters.workspace_id) rows = rows.filter((r) => r.workspace_id === filters.workspace_id);
      if (typeof filters.is_active === "boolean") {
        rows = rows.filter((r) => r.is_active === filters.is_active);
      }
      if (inFilters.variant_id) {
        rows = rows.filter((r) => (inFilters.variant_id as string[]).includes(r.variant_id));
      }
      if (filters.variant_id) {
        rows = rows.filter((r) => r.variant_id === filters.variant_id);
      }
      return rows;
    }
    if (table === "product_pricing_rule") {
      let rows = world.productPricingRule.slice();
      if (inFilters.product_id) {
        rows = rows.filter((r) => (inFilters.product_id as string[]).includes(r.product_id));
      }
      return rows;
    }
    if (table === "pricing_rules") {
      let rows = world.pricingRules.slice();
      if (inFilters.id) rows = rows.filter((r) => (inFilters.id as string[]).includes(r.id));
      return rows;
    }
    if (table === "digital_goods") {
      return world.digitalGoods.find(
        (g) => g.id === filters.id && (!filters.workspace_id || filters.workspace_id === WORKSPACE_ID),
      ) || null;
    }
    if (table === "products") {
      const row = world.products[String(filters.id)];
      return row || null;
    }
    return null;
  }

  const builder: QueryBuilder = {
    select() {
      return builder;
    },
    eq(col, val) {
      filters[col] = val;
      return builder;
    },
    in(col, vals) {
      inFilters[col] = vals;
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    async maybeSingle() {
      const r = resolve();
      if (Array.isArray(r)) return { data: r[0] || null, error: null };
      return { data: r ?? null, error: null };
    },
    async single() {
      const r = resolve();
      if (Array.isArray(r)) return { data: r[0] || null, error: null };
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

const stubAdmin = {
  from(table: string) {
    return makeFrom(table);
  },
};

// Wire the stubs into Node's module cache BEFORE we import cart-gifts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};
moduleAny._cache[require.resolve("@/lib/product-variants")] = {
  exports: {
    findVariant: async (_workspaceId: string, ref: { id?: string }) => {
      const id = ref.id || "";
      return variants[id] || null;
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensureCartAttachments, ensureOfferItems, ensureFreeGifts } =
  require("./cart-gifts") as typeof import("./cart-gifts");

interface Line {
  variant_id: string;
  product_id: string;
  shopify_variant_id: string | null;
  sku?: string | null;
  title: string;
  variant_title: string | null;
  image_url: string | null;
  quantity: number;
  unit_price_cents: number;
  unit_msrp_cents: number;
  price_cents_at_add: number;
  line_total_cents: number;
  mode: "subscribe" | "onetime";
  frequency_days: number | null;
  is_gift?: boolean;
  gift_source_product_id?: string;
  offer_source_variant_id?: string;
  digital_good_id?: string;
}

const paidAnchorLine: Line = {
  variant_id: ANCHOR_VARIANT_ID,
  product_id: ANCHOR_PRODUCT_ID,
  shopify_variant_id: null,
  sku: "SKU-ANCHOR",
  title: "Anchor Product",
  variant_title: null,
  image_url: null,
  quantity: 1,
  unit_price_cents: 4995,
  unit_msrp_cents: 4995,
  price_cents_at_add: 4995,
  line_total_cents: 4995,
  mode: "subscribe",
  frequency_days: 30,
};

function seedOffer(overrides: Partial<OfferRow> = {}): OfferRow {
  const row: OfferRow = {
    id: "offer-1",
    workspace_id: WORKSPACE_ID,
    variant_id: ANCHOR_VARIANT_ID,
    name: "Starter Kit",
    included: [
      { ref_id: PHYSICAL_VARIANT_ID, kind: "physical", quantity: 1 },
      { ref_id: DIGITAL_GOOD_ID, kind: "digital", quantity: 1 },
    ],
    scope: "checkout_only",
    overrides_pricing_rule_gifts: false,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
  world.offers.push(row);
  world.digitalGoods.push({ id: DIGITAL_GOOD_ID, name: "E-guide", type: "downloadable" });
  return row;
}

function seedRuleGift() {
  world.productPricingRule.push({ product_id: ANCHOR_PRODUCT_ID, pricing_rule_id: PRICING_RULE_ID });
  world.pricingRules.push({
    id: PRICING_RULE_ID,
    free_gift_variant_id: RULE_GIFT_VARIANT_ID,
    free_gift_min_quantity: 1,
    free_gift_subscription_only: false,
    free_gift_image_url: null,
    free_gift_product_title: "Rule Gift",
  });
}

test("Phase 2: an offer with physical + digital includes attaches both as $0 lines — physical carries sku, digital omits sku and carries digital_good_id", async () => {
  resetWorld();
  seedOffer();

  const result = await ensureOfferItems(WORKSPACE_ID, [paidAnchorLine]);

  const gifts = result.filter((l) => l.is_gift);
  assert.equal(gifts.length, 2, "one physical + one digital line attached");
  assert.ok(gifts.every((l) => l.unit_price_cents === 0 && l.line_total_cents === 0), "$0 lines");

  const physical = gifts.find((l) => l.variant_id === PHYSICAL_VARIANT_ID);
  assert.ok(physical, "physical line present");
  assert.equal(physical!.sku, "SKU-FROTHER", "physical carries the real sku — Amplifier will fulfill");
  assert.equal(physical!.digital_good_id, undefined, "physical carries no digital_good_id");
  assert.equal(physical!.offer_source_variant_id, ANCHOR_VARIANT_ID, "tagged for Phase 3 renewal-strip");

  const digital = gifts.find((l) => l.digital_good_id === DIGITAL_GOOD_ID);
  assert.ok(digital, "digital line present");
  assert.equal(digital!.sku ?? null, null, "digital carries NO sku — Amplifier sku filter drops it");
  assert.equal(digital!.digital_good_id, DIGITAL_GOOD_ID, "digital_good_id set — triggers digital-goods-delivery");
  assert.equal(digital!.offer_source_variant_id, ANCHOR_VARIANT_ID, "tagged for Phase 3 renewal-strip");
});

test("Phase 2: with no active offer for the variant, ensureOfferItems is a no-op", async () => {
  resetWorld();

  const result = await ensureOfferItems(WORKSPACE_ID, [paidAnchorLine]);
  assert.equal(result.length, 1);
  assert.equal(result.filter((l) => l.is_gift).length, 0);
});

test("Phase 2: when overrides_pricing_rule_gifts=true, the pricing-rule free_gift for the anchor's product is skipped — only the offer's items are attached", async () => {
  resetWorld();
  seedOffer({ overrides_pricing_rule_gifts: true });
  seedRuleGift();

  const result = await ensureCartAttachments(WORKSPACE_ID, [paidAnchorLine]);

  const gifts = result.filter((l) => l.is_gift);
  // Only the two offer-sourced lines — not the pricing-rule free gift.
  const ruleGiftPresent = gifts.some((l) => l.variant_id === RULE_GIFT_VARIANT_ID);
  assert.equal(ruleGiftPresent, false, "pricing-rule free_gift was skipped by the override flag");
  assert.equal(
    gifts.filter((l) => l.offer_source_variant_id === ANCHOR_VARIANT_ID).length,
    2,
    "both offer-sourced lines present",
  );
});

test("Phase 2: when overrides_pricing_rule_gifts=false, BOTH the offer's items AND the rule free_gift attach", async () => {
  resetWorld();
  seedOffer({ overrides_pricing_rule_gifts: false });
  seedRuleGift();

  const result = await ensureCartAttachments(WORKSPACE_ID, [paidAnchorLine]);

  const gifts = result.filter((l) => l.is_gift);
  const offerCount = gifts.filter((l) => l.offer_source_variant_id === ANCHOR_VARIANT_ID).length;
  const ruleGift = gifts.find((l) => l.variant_id === RULE_GIFT_VARIANT_ID);
  assert.equal(offerCount, 2, "both offer-sourced lines present");
  assert.ok(ruleGift, "pricing-rule free_gift also present when override is off");
});

test("Phase 2: re-running ensureCartAttachments is idempotent — offer-sourced lines are re-derived, not duplicated", async () => {
  resetWorld();
  seedOffer();

  const first = await ensureCartAttachments(WORKSPACE_ID, [paidAnchorLine]);
  const second = await ensureCartAttachments(WORKSPACE_ID, first);

  const firstGifts = first.filter((l) => l.is_gift).length;
  const secondGifts = second.filter((l) => l.is_gift).length;
  assert.equal(firstGifts, 2);
  assert.equal(secondGifts, 2, "re-run does not double the offer lines");
});

test("Phase 2 (fallback path): ensureFreeGifts called alone still respects the override flag by re-querying offers", async () => {
  resetWorld();
  seedOffer({ overrides_pricing_rule_gifts: true });
  seedRuleGift();

  // Simulate a caller that only knows about ensureFreeGifts (legacy path).
  const result = await ensureFreeGifts(WORKSPACE_ID, [paidAnchorLine]);

  const ruleGift = result.find((l) => l.variant_id === RULE_GIFT_VARIANT_ID);
  assert.equal(ruleGift, undefined, "override flag skips the rule free_gift on the standalone path too");
});
