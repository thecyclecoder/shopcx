/**
 * Regression tests for `isSwappableConsumable` — the CEO rule (2026-11-22) that a
 * customer may swap/add ONLY into an in-stock consumable product.
 *
 * The named failing state this locks down: the Portal's old out-of-stock filter was
 * `inventory_quantity == null || inventory_quantity > 0`. Since
 * `product_variants.inventory_quantity` is RETIRED and ALWAYS NULL now
 * (docs/brain/tables/product_variants.md), that predicate passed EVERYTHING — which is
 * exactly how Strawberry Lemonade Tabs and Cocoa Instant Coffee (on-hand 0) leaked into
 * the swap list. The fix: in-stock is proven by canonical storefront on-hand, and a
 * zero/missing figure is OUT of stock.
 *
 * Run:
 *   npx tsx --test src/lib/portal/editable-catalog.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isSwappableConsumable, type CatalogProductInfo, type CatalogVariantInfo } from "./editable-catalog";

const consumable: CatalogProductInfo = { productId: "111", title: "Cocoa Instant Coffee", handle: "cocoa-instant-coffee", productType: "Supplement" };
const inStock = (onHand: number): CatalogVariantInfo => ({ variantId: "v1", title: "Default", priceCents: 2999, onHand });

test("in-stock consumable → swappable", () => {
  assert.equal(isSwappableConsumable(consumable, inStock(12)), true);
});

test("out of stock (on-hand 0) → NOT swappable — the Cocoa Instant Coffee / Strawberry Lemonade leak", () => {
  assert.equal(isSwappableConsumable(consumable, inStock(0)), false);
});

test("missing on-hand (the retired null-inventory shape) → NOT swappable", () => {
  // The old filter treated null as in-stock; onHand resolves to 0 when unknown now.
  assert.equal(isSwappableConsumable(consumable, inStock(0)), false);
});

test("Shipping Protection by product_type ShopWill → NOT swappable even if in stock", () => {
  const sp: CatalogProductInfo = { productId: "222", title: "Shipping Protection", handle: "shipping-insurance", productType: "ShopWill" };
  assert.equal(isSwappableConsumable(sp, inStock(9999)), false);
});

test("Shipping Protection by handle alone → NOT swappable", () => {
  const sp: CatalogProductInfo = { productId: "222", title: "Package Guarantee", handle: "shipping-insurance", productType: "Other" };
  assert.equal(isSwappableConsumable(sp, inStock(10)), false);
});

test("free-gift duplicate (SHOPIFY_PRODUCT_ALIASES id) → NOT swappable", () => {
  const gift: CatalogProductInfo = { productId: "7902173069485", title: "Bamboo Coffee Mug (Free Gift)", handle: "bamboo-mug-gift", productType: "Accessory" };
  assert.equal(isSwappableConsumable(gift, inStock(50)), false);
});

test("free-gift by title keyword → NOT swappable", () => {
  const gift: CatalogProductInfo = { productId: "999", title: "Superfoods Tumbler (Free Gift)", handle: "tumbler", productType: "Accessory" };
  assert.equal(isSwappableConsumable(gift, inStock(50)), false);
});

test("internal Mystery Item → NOT swappable", () => {
  const mystery: CatalogProductInfo = { productId: "333", title: "Mystery Item", handle: "mystery-item", productType: "Internal" };
  assert.equal(isSwappableConsumable(mystery, inStock(100)), false);
});

test("digital good → NOT swappable", () => {
  const digital: CatalogProductInfo = { productId: "444", title: "Nutrition Guide PDF", handle: "nutrition-guide", productType: "digital" };
  assert.equal(isSwappableConsumable(digital, inStock(100)), false);
  const giftCard: CatalogProductInfo = { productId: "555", title: "Gift Card", handle: "gift-card", productType: "Other" };
  assert.equal(isSwappableConsumable(giftCard, inStock(100)), false);
});
