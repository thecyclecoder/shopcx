/**
 * Unit tests for the PURE remapBundleLinesToBase() core. Built-in node:test:
 *   npx tsx --test src/lib/bundle-fulfillment.test.ts
 *
 * Context: the Starter Kit sells via a marker variant (SF-STARTER-KIT) that
 * anchors the bundle offer but isn't stocked at the 3PL. At checkout we remap
 * that paid line to the product's base variant (Cocoa) so the order ships, while
 * gift / offer-sourced lines are left exactly as-is.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { remapBundleLinesToBase, type BaseVariantTarget, type RemappableLine } from "./bundle-fulfillment";

const COCOA: BaseVariantTarget = {
  id: "9ef9311d",
  product_id: "ea433e56",
  sku: "SC-INSTANTCO-COCOA",
  variant_title: "Cocoa French Roast",
  image_url: "cocoa.jpg",
};
const map = new Map([["0a631380", COCOA]]); // SF-STARTER-KIT variant → base coffee

test("remaps the paid Starter Kit marker line to the base coffee variant", () => {
  const lines: RemappableLine[] = [
    { variant_id: "0a631380", product_id: "ea433e56", sku: "SF-STARTER-KIT", title: "Amazing Coffee", variant_title: "Starter Kit", image_url: "kit.jpg", quantity: 1 } as RemappableLine,
  ];
  const out = remapBundleLinesToBase(lines, map);
  assert.equal(out[0].variant_id, "9ef9311d");
  assert.equal(out[0].sku, "SC-INSTANTCO-COCOA");
  assert.equal(out[0].variant_title, "Cocoa French Roast");
  assert.equal(out[0].title, "Amazing Coffee"); // product title preserved
  assert.equal(out[0].image_url, "kit.jpg");    // existing image preserved
});

test("NEVER remaps a gift line even if its variant matches a bundle marker", () => {
  const lines: RemappableLine[] = [
    { variant_id: "0a631380", sku: "SF-STARTER-KIT", is_gift: true },
  ];
  const out = remapBundleLinesToBase(lines, map);
  assert.equal(out[0].variant_id, "0a631380");
  assert.equal(out[0].sku, "SF-STARTER-KIT");
});

test("NEVER remaps an offer-sourced line", () => {
  const lines: RemappableLine[] = [
    { variant_id: "0a631380", sku: "SF-STARTER-KIT", offer_source_variant_id: "0a631380" },
  ];
  const out = remapBundleLinesToBase(lines, map);
  assert.equal(out[0].variant_id, "0a631380");
});

test("leaves non-bundle paid lines untouched", () => {
  const lines: RemappableLine[] = [
    { variant_id: "aaa", sku: "SC-CREAMER-CARAMEL", title: "Amazing Creamer" },
  ];
  const out = remapBundleLinesToBase(lines, map);
  assert.equal(out[0].sku, "SC-CREAMER-CARAMEL");
});

test("falls back to the base variant image only when the line has none", () => {
  const lines: RemappableLine[] = [
    { variant_id: "0a631380", sku: "SF-STARTER-KIT", image_url: null },
  ];
  const out = remapBundleLinesToBase(lines, map);
  assert.equal(out[0].image_url, "cocoa.jpg");
});

test("empty map is a no-op", () => {
  const lines: RemappableLine[] = [{ variant_id: "0a631380", sku: "SF-STARTER-KIT" }];
  const out = remapBundleLinesToBase(lines, new Map());
  assert.equal(out[0].sku, "SF-STARTER-KIT");
});

test("mixed cart: remaps only the marker paid line, preserves gift + other lines", () => {
  const lines: RemappableLine[] = [
    { variant_id: "0a631380", sku: "SF-STARTER-KIT", title: "Amazing Coffee", variant_title: "Starter Kit" },
    { variant_id: "6b09d7d2", sku: "ASC-MIX-1", is_gift: true, offer_source_variant_id: "0a631380" },
    { variant_id: "bbb", sku: "SC-CREATINE-BC", title: "Creatine Prime+" },
  ];
  const out = remapBundleLinesToBase(lines, map);
  assert.equal(out[0].sku, "SC-INSTANTCO-COCOA"); // marker → base
  assert.equal(out[1].sku, "ASC-MIX-1");          // gift untouched
  assert.equal(out[2].sku, "SC-CREATINE-BC");     // other line untouched
});
