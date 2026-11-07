/**
 * Parity tests for the engine copy of src/lib/address-normalize.ts. The
 * shared-address key is computed from `normalizeAddress` at ingest, so the
 * engine copy must never drift from what ShopCX stores.
 *
 * Run: npx tsx --test src/lib/engine/fraud/address-normalize.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAddress, normalizeShopifyShippingAddress, shopifyAddressToSnake, resolveOrderAddresses } from "./index";
import * as legacy from "../../address-normalize";

const samples: Array<Record<string, unknown> | null> = [
  null,
  {},
  { address1: "7704 Romaine Street", address2: "Apt. #2", city: "Los Angeles", province: "California", zip: "90000", country: "US" },
  { address1: "10083 Lynden Oval", address2: "Suite 100", city: "Cleveland", province: "OH", zip: "44130" },
  { address1: "1 North-West Parkway", address2: "No. 5", city: "O'Fallon", province: "MO", zip: "63366" },
  { firstName: "Ann", lastName: "Lee", address1: "5 Main Ave", provinceCode: "CA", countryCode: "US", zip: "94002" },
  { first_name: "Ann", name: "A. Lee", address1: "5 Main Ave", province_code: "CA", country_code: "US" },
];

test("normalizeAddress + normalizeShopifyShippingAddress match legacy", () => {
  assert.equal(normalizeAddress(samples[2] as never), "7704 romaine st unit 2 los angeles california 90000 us");
  for (const s of samples) {
    assert.equal(normalizeAddress(s as never), legacy.normalizeAddress(s as never), JSON.stringify(s));
    assert.equal(normalizeShopifyShippingAddress(s), legacy.normalizeShopifyShippingAddress(s), JSON.stringify(s));
  }
});

test("shopifyAddressToSnake + resolveOrderAddresses fallback chain match legacy", () => {
  for (const s of samples) assert.deepEqual(shopifyAddressToSnake(s), legacy.shopifyAddressToSnake(s));
  for (const a of samples) for (const b of samples) {
    assert.deepEqual(resolveOrderAddresses(a, b, samples[3]), legacy.resolveOrderAddresses(a, b, samples[3]));
    assert.deepEqual(resolveOrderAddresses(a, b, null), legacy.resolveOrderAddresses(a, b, null));
  }
});
