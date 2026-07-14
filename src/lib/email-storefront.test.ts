/**
 * Unit tests for the UUID-shape guard on the featured-review query.
 * Regression test for the Shipping-Protection-line-item 22P02 that
 * silently dropped the social-proof block from the whole order.
 *
 *   npx tsx --test src/lib/email-storefront.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isReviewableProduct, uuidLineItemProductIds } from "./email-storefront";

const SHIPPING_PROTECTION_SHOPIFY_ID = "7634377900205";
const VALID_UUID = "ee261540-4b0e-4c8a-9a0f-5e3f7c9d1234";
const OTHER_UUID = "12345678-1234-1234-1234-1234567890ab";

test("Shipping Protection's Shopify numeric id is dropped; the valid UUID survives", () => {
  const out = uuidLineItemProductIds([VALID_UUID, SHIPPING_PROTECTION_SHOPIFY_ID]);
  assert.deepEqual(out, [VALID_UUID]);
});

test("null / undefined / empty entries are dropped without throwing", () => {
  const out = uuidLineItemProductIds([null, undefined, "", VALID_UUID]);
  assert.deepEqual(out, [VALID_UUID]);
});

test("all-Shopify-numeric input returns an empty array (no query would fire)", () => {
  const out = uuidLineItemProductIds([SHIPPING_PROTECTION_SHOPIFY_ID, "999", "42"]);
  assert.deepEqual(out, []);
});

test("mixed valid UUIDs pass through unchanged", () => {
  const out = uuidLineItemProductIds([VALID_UUID, OTHER_UUID]);
  assert.deepEqual(out, [VALID_UUID, OTHER_UUID]);
});

test("case-insensitive UUID: uppercase hex is still a UUID", () => {
  const upper = VALID_UUID.toUpperCase();
  const out = uuidLineItemProductIds([upper]);
  assert.deepEqual(out, [upper]);
});

test("almost-UUID (missing hyphen / wrong length) is rejected — the whole point of the guard", () => {
  const missingHyphen = VALID_UUID.replace("-", "");
  const tooShort = VALID_UUID.slice(0, -1);
  const out = uuidLineItemProductIds([missingHyphen, tooShort, VALID_UUID]);
  assert.deepEqual(out, [VALID_UUID]);
});

// isReviewableProduct — identity-based exclusion of non-reviewable
// add-ons (Shipping Protection). This is the semantic guard: it holds
// even if a shipping-protection line ever carries a valid product
// UUID that would sneak past uuidLineItemProductIds.

test("Shipping Protection by product_type=ShopWill is not reviewable — even with a valid UUID", () => {
  assert.equal(isReviewableProduct({ product_type: "ShopWill", handle: "shipping-insurance" }), false);
});

test("Shipping Protection by handle alone is not reviewable — belt-and-suspenders", () => {
  assert.equal(isReviewableProduct({ product_type: null, handle: "shipping-insurance" }), false);
});

test("product_type match is case-insensitive (SHOPWILL / shopwill)", () => {
  assert.equal(isReviewableProduct({ product_type: "SHOPWILL" }), false);
  assert.equal(isReviewableProduct({ product_type: "shopwill" }), false);
});

test("real product (coffee) IS reviewable — nothing else is excluded by accident", () => {
  assert.equal(isReviewableProduct({ product_type: "Coffee", handle: "amazing-coffee" }), true);
});

test("missing / empty identity fields default to reviewable — only known add-on markers exclude", () => {
  assert.equal(isReviewableProduct({}), true);
  assert.equal(isReviewableProduct({ product_type: "", handle: "" }), true);
  assert.equal(isReviewableProduct({ product_type: null, handle: null }), true);
});
