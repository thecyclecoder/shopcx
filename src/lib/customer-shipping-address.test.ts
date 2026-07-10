/**
 * Regression pins for the shared current-address resolver
 * (docs/brain/specs/replacement-address-uses-current-canonical-not-stale-order.md,
 * Phase 1). Grounded in ticket 49ddd6c4 (Catherine Green — replacement
 * shipped to a stale Rochester MN snapshot when both her account
 * default AND her subscription said Kirkland WA).
 *
 * The tests hit the pure picker `pickCanonicalShippingAddress` so the
 * priority + divergence logic is verifiable without a Supabase mock.
 *
 * Run:
 *   npx tsx --test src/lib/customer-shipping-address.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAddress,
  pickCanonicalShippingAddress,
  sameShippingAddress,
  formatDivergenceNote,
} from "./customer-shipping-address";

// Catherine Green — the ticket 49ddd6c4 shape.
const KIRKLAND = {
  first_name: "Catherine",
  last_name: "Green",
  address1: "123 Lake St",
  city: "Kirkland",
  province_code: "WA",
  zip: "98033",
  country_code: "US",
};
const ROCHESTER = {
  first_name: "Catherine",
  last_name: "Green",
  address1: "45 Old Ave",
  city: "Rochester",
  province_code: "MN",
  zip: "55901",
  country_code: "US",
};
const KIRKLAND_OVERRIDE = {
  first_name: "Catherine",
  last_name: "Green",
  address1: "789 Different Way",
  city: "Kirkland",
  state: "WA",
  postal_code: "98034",
  country: "US",
};

test("[49ddd6c4] account default + subscription say Kirkland, cited order says Rochester → resolves to Kirkland (default_address wins)", () => {
  const resolved = pickCanonicalShippingAddress({
    defaultAddress: KIRKLAND,
    subscriptionAddress: KIRKLAND,
    citedOrderAddress: ROCHESTER,
  });
  assert.ok(resolved, "must resolve");
  assert.equal(resolved!.address.city, "Kirkland");
  assert.equal(resolved!.address.provinceCode, "WA");
  assert.equal(resolved!.address.zip, "98033");
  assert.equal(resolved!.source, "default_address");
  assert.equal(resolved!.diverged, true, "cited-order divergence must be flagged");
  assert.ok(resolved!.citedOrderAddress);
  assert.equal(resolved!.citedOrderAddress!.city, "Rochester");
});

test("explicit override wins over everything (operator forcing a one-off destination)", () => {
  const resolved = pickCanonicalShippingAddress({
    addressOverride: KIRKLAND_OVERRIDE,
    defaultAddress: KIRKLAND,
    subscriptionAddress: KIRKLAND,
    citedOrderAddress: ROCHESTER,
  });
  assert.ok(resolved);
  assert.equal(resolved!.source, "override");
  assert.equal(resolved!.address.address1, "789 Different Way");
  // Override intentionally suppresses the divergence note — the
  // operator already chose the destination.
  assert.equal(resolved!.diverged, false);
});

test("last-resort fallback preserved — only a cited order on file → uses it", () => {
  const resolved = pickCanonicalShippingAddress({
    citedOrderAddress: ROCHESTER,
  });
  assert.ok(resolved);
  assert.equal(resolved!.source, "cited_order");
  assert.equal(resolved!.address.city, "Rochester");
  // No canonical current source disagreed → nothing to diverge from.
  assert.equal(resolved!.diverged, false);
});

test("recent-order safety net — nothing else on file → picks it (source=recent_order)", () => {
  const resolved = pickCanonicalShippingAddress({
    recentOrderAddress: ROCHESTER,
  });
  assert.ok(resolved);
  assert.equal(resolved!.source, "recent_order");
});

test("no source at all → returns null (order-creating action must fail loudly)", () => {
  assert.equal(pickCanonicalShippingAddress({}), null);
});

test("subscription-only customer (no default_address) → subscription wins over cited order + flags divergence", () => {
  const resolved = pickCanonicalShippingAddress({
    subscriptionAddress: KIRKLAND,
    citedOrderAddress: ROCHESTER,
  });
  assert.ok(resolved);
  assert.equal(resolved!.source, "subscription");
  assert.equal(resolved!.address.city, "Kirkland");
  assert.equal(resolved!.diverged, true);
});

test("cited order agrees with the canonical current source → chosen source is default_address, diverged=false", () => {
  const resolved = pickCanonicalShippingAddress({
    defaultAddress: KIRKLAND,
    citedOrderAddress: KIRKLAND,
  });
  assert.ok(resolved);
  assert.equal(resolved!.source, "default_address");
  assert.equal(resolved!.diverged, false);
});

test("normalizeAddress collapses Shopify shape, our shape, and camelCase override shape identically", () => {
  const shopify = normalizeAddress({
    first_name: "A", last_name: "B",
    address1: "1 Main St", address2: "Apt 2",
    city: "Kirkland", province: "Washington", province_code: "WA",
    zip: "98033", country: "United States", country_code: "US",
  });
  const ours = normalizeAddress({
    first_name: "A", last_name: "B",
    address1: "1 Main St", address2: "Apt 2",
    city: "Kirkland", province_code: "WA",
    zip: "98033", country_code: "US",
  });
  const camel = normalizeAddress({
    firstName: "A", lastName: "B",
    address1: "1 Main St", address2: "Apt 2",
    city: "Kirkland", provinceCode: "WA",
    zip: "98033", countryCode: "US",
  });
  assert.deepEqual(shopify, ours);
  assert.deepEqual(shopify, camel);
});

test("normalizeAddress returns null on empty / missing address1 (empty source shouldn't win the priority chain)", () => {
  assert.equal(normalizeAddress(null), null);
  assert.equal(normalizeAddress(undefined), null);
  assert.equal(normalizeAddress({}), null);
  assert.equal(normalizeAddress({ city: "Kirkland" }), null);
  assert.equal(normalizeAddress({ address1: "   " }), null);
});

test("sameShippingAddress agrees on formatting/case drift, disagrees on real moves", () => {
  const a = normalizeAddress(KIRKLAND)!;
  const b = normalizeAddress({ ...KIRKLAND, address1: "123 lake st" })!;
  const c = normalizeAddress(ROCHESTER)!;
  assert.equal(sameShippingAddress(a, b), true);
  assert.equal(sameShippingAddress(a, c), false);
});

test("empty override object (no address1) doesn't hijack the priority chain — falls through to default_address", () => {
  const resolved = pickCanonicalShippingAddress({
    addressOverride: { first_name: "X" },
    defaultAddress: KIRKLAND,
    citedOrderAddress: ROCHESTER,
  });
  assert.ok(resolved);
  assert.equal(resolved!.source, "default_address");
  assert.equal(resolved!.diverged, true);
});

test("[SC132221] normalizeAddress with country='United States' (no country_code) yields countryCode='US', not the sliced-to-2-chars 'UN' that stranded Evan H.'s replacement for 17 days", () => {
  const evan = normalizeAddress({
    first_name: "Evan", last_name: "H",
    address1: "1 Somewhere St",
    city: "Anytown",
    province_code: "OR",
    zip: "97000",
    country: "United States",
    // country_code: absent — the SC132221 shape.
  });
  assert.ok(evan);
  assert.equal(evan!.countryCode, "US");
  assert.notEqual(evan!.countryCode, "UN");
});

test("normalizeAddress with country='us' (lowercase 2-letter) still yields 'US'", () => {
  const a = normalizeAddress({
    address1: "1 Somewhere St", city: "Anytown", province_code: "OR", zip: "97000",
    country: "us",
  });
  assert.ok(a);
  assert.equal(a!.countryCode, "US");
});

test("normalizeAddress with blank country falls back to the store default 'US' (never yields the empty string that would blow up Shopify)", () => {
  const a = normalizeAddress({
    address1: "1 Somewhere St", city: "Anytown", province_code: "OR", zip: "97000",
    country: "", country_code: "",
  });
  assert.ok(a);
  assert.equal(a!.countryCode, "US");
});

test("formatDivergenceNote produces a human-readable line naming the from/to and the citing order", () => {
  const resolved = pickCanonicalShippingAddress({
    defaultAddress: KIRKLAND,
    citedOrderAddress: ROCHESTER,
  })!;
  const note = formatDivergenceNote(resolved, "1234");
  assert.match(note, /Rochester/);
  assert.match(note, /Kirkland/);
  assert.match(note, /order 1234/);
  assert.match(note, /customer moved/i);
});
