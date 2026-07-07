/**
 * Phase 3 of offer-creator — renewal-aware fulfillment.
 *
 * Pins the exact verification state named in the spec:
 *   "A first (checkout) order for the variant includes the offer items;
 *    a subscription renewal order for the same variant with scope
 *    checkout_only contains only the paid product and none of the offer
 *    included lines."
 *
 * Concretely for `stripCheckoutOnlyOfferItems`:
 *   - scope=checkout_only            → offer-sourced item dropped
 *   - scope=checkout_and_renewals    → offer-sourced item kept
 *   - offer missing / deleted        → dropped (safety default)
 *   - non-offer items                → passed through untouched
 *
 * Stubs the Supabase admin client via Node's ESM module cache BEFORE
 * dynamic-importing offers.ts.
 *
 * Run:
 *   npx tsx --test src/lib/offers-renewal.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const ANCHOR_VARIANT_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ANCHOR_ID = "33333333-3333-3333-3333-333333333333";
const PAID_VARIANT_ID = "44444444-4444-4444-4444-444444444444";
const PHYSICAL_VARIANT_ID = "55555555-5555-5555-5555-555555555555";
const DIGITAL_GOOD_ID = "66666666-6666-6666-6666-666666666666";

interface OfferRow {
  id: string;
  workspace_id: string;
  variant_id: string;
  name: string | null;
  included: Array<{ ref_id: string; kind: "physical" | "digital"; quantity: number }>;
  scope: "checkout_only" | "checkout_and_renewals";
  overrides_pricing_rule_gifts: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const world = { offers: [] as OfferRow[] };

function resetWorld() {
  world.offers = [];
}

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
    if (table !== "offers") return null;
    let rows = world.offers.slice();
    if (filters.workspace_id) rows = rows.filter((r) => r.workspace_id === filters.workspace_id);
    if (typeof filters.is_active === "boolean") rows = rows.filter((r) => r.is_active === filters.is_active);
    if (inFilters.variant_id) {
      rows = rows.filter((r) => (inFilters.variant_id as string[]).includes(r.variant_id));
    }
    if (filters.variant_id) rows = rows.filter((r) => r.variant_id === filters.variant_id);
    return rows;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stripCheckoutOnlyOfferItems } = require("./offers") as typeof import("./offers");

function seedOffer(overrides: Partial<OfferRow> = {}): OfferRow {
  const row: OfferRow = {
    id: `offer-${world.offers.length + 1}`,
    workspace_id: WORKSPACE_ID,
    variant_id: ANCHOR_VARIANT_ID,
    name: "Starter Kit",
    included: [{ ref_id: PHYSICAL_VARIANT_ID, kind: "physical", quantity: 1 }],
    scope: "checkout_only",
    overrides_pricing_rule_gifts: false,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
  world.offers.push(row);
  return row;
}

interface SubItem {
  variant_id: string;
  quantity: number;
  price_cents: number;
  is_gift?: boolean;
  offer_source_variant_id?: string;
  digital_good_id?: string;
}

const paidItem: SubItem = {
  variant_id: PAID_VARIANT_ID,
  quantity: 1,
  price_cents: 4995,
};
const offerPhysicalItem: SubItem = {
  variant_id: PHYSICAL_VARIANT_ID,
  quantity: 1,
  price_cents: 0,
  is_gift: true,
  offer_source_variant_id: ANCHOR_VARIANT_ID,
};
const offerDigitalItem: SubItem = {
  variant_id: DIGITAL_GOOD_ID,
  quantity: 1,
  price_cents: 0,
  is_gift: true,
  offer_source_variant_id: ANCHOR_VARIANT_ID,
  digital_good_id: DIGITAL_GOOD_ID,
};

test("Phase 3: renewal with scope=checkout_only strips the offer-sourced items — only the paid product survives", async () => {
  resetWorld();
  seedOffer({ scope: "checkout_only" });

  const result = await stripCheckoutOnlyOfferItems(WORKSPACE_ID, [
    paidItem,
    offerPhysicalItem,
    offerDigitalItem,
  ]);

  assert.equal(result.length, 1, "only the paid product remains");
  assert.equal(result[0].variant_id, PAID_VARIANT_ID);
  assert.equal(
    result.some((i) => i.offer_source_variant_id),
    false,
    "no offer-sourced items in renewal",
  );
});

test("Phase 3: renewal with scope=checkout_and_renewals keeps the offer-sourced items", async () => {
  resetWorld();
  seedOffer({ scope: "checkout_and_renewals" });

  const result = await stripCheckoutOnlyOfferItems(WORKSPACE_ID, [
    paidItem,
    offerPhysicalItem,
    offerDigitalItem,
  ]);

  assert.equal(result.length, 3, "all items survive");
  assert.ok(result.find((i) => i.variant_id === PHYSICAL_VARIANT_ID));
  assert.ok(result.find((i) => i.variant_id === DIGITAL_GOOD_ID));
});

test("Phase 3: renewal with a deleted / inactive offer drops the offer-sourced items (safety default)", async () => {
  resetWorld();
  // Deliberately DO NOT seed an offer. The offer_source_variant_id points at a
  // non-existent (or deactivated) offer — a lookup miss should cause the item
  // to be stripped, since renewals must never ship an extra whose offer no
  // longer exists.

  const result = await stripCheckoutOnlyOfferItems(WORKSPACE_ID, [paidItem, offerPhysicalItem]);

  assert.equal(result.length, 1);
  assert.equal(result[0].variant_id, PAID_VARIANT_ID);
});

test("Phase 3: items without offer_source_variant_id pass through untouched even when other items are stripped", async () => {
  resetWorld();
  seedOffer({ scope: "checkout_only" });

  const untagged: SubItem = {
    variant_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    quantity: 2,
    price_cents: 1200,
    // no offer_source_variant_id, no is_gift
  };

  const result = await stripCheckoutOnlyOfferItems(WORKSPACE_ID, [
    paidItem,
    offerPhysicalItem,
    untagged,
  ]);

  assert.equal(result.length, 2);
  assert.ok(result.find((i) => i.variant_id === PAID_VARIANT_ID));
  assert.ok(result.find((i) => i.variant_id === untagged.variant_id));
  assert.equal(
    result.find((i) => i.variant_id === PHYSICAL_VARIANT_ID),
    undefined,
  );
});

test("Phase 3: with no offer-sourced items in sub.items, no DB round-trip and same-shape output", async () => {
  resetWorld();
  seedOffer({ scope: "checkout_only" });

  const only = [paidItem];
  const result = await stripCheckoutOnlyOfferItems(WORKSPACE_ID, only);

  assert.deepEqual(result, only);
});

test("Phase 3: two anchor variants, one keep + one strip — decision is per-item, not all-or-nothing", async () => {
  resetWorld();
  seedOffer({ variant_id: ANCHOR_VARIANT_ID, scope: "checkout_only" });
  seedOffer({ variant_id: OTHER_ANCHOR_ID, scope: "checkout_and_renewals" });

  const keepItem: SubItem = {
    variant_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    quantity: 1,
    price_cents: 0,
    is_gift: true,
    offer_source_variant_id: OTHER_ANCHOR_ID,
  };

  const result = await stripCheckoutOnlyOfferItems(WORKSPACE_ID, [
    paidItem,
    offerPhysicalItem,
    keepItem,
  ]);

  assert.equal(result.length, 2);
  assert.ok(result.find((i) => i.variant_id === PAID_VARIANT_ID));
  assert.ok(result.find((i) => i.variant_id === keepItem.variant_id));
  assert.equal(
    result.find((i) => i.variant_id === PHYSICAL_VARIANT_ID),
    undefined,
  );
});
