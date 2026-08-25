/**
 * The duplicate-product fold is the one piece of [[shopify-review-metafields]]
 * that silently puts reviews on the wrong page when it's wrong, and the one the
 * theme-facing feed has to agree with exactly. A drifted fold shows a PDP
 * header of 73 above a product card reading 15.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHOPIFY_PRODUCT_ALIASES,
  canonicalShopifyId,
  shopifyIdsFoldingInto,
} from "@/lib/shopify-review-metafields";

test("canonicalShopifyId folds a duplicate onto its canonical product", () => {
  // Superfoods Tumbler (Free Gift) → Superfoods Tumbler.
  assert.equal(canonicalShopifyId("7902086725805"), "7497753460909");
});

test("canonicalShopifyId leaves an unaliased id alone", () => {
  assert.equal(canonicalShopifyId("7465708093613"), "7465708093613"); // Superfood Tabs
});

test("shopifyIdsFoldingInto returns the canonical id plus every duplicate", () => {
  const ids = shopifyIdsFoldingInto("7497753460909"); // canonical Tumbler
  assert.ok(ids.includes("7497753460909"), "canonical id present");
  assert.ok(ids.includes("7902086725805"), "free-gift duplicate present");
});

test("shopifyIdsFoldingInto is symmetric — asking with the duplicate finds the canonical set", () => {
  const fromDupe = shopifyIdsFoldingInto("7902086725805");
  assert.ok(fromDupe.includes("7497753460909"), "canonical reachable from the duplicate");
  assert.ok(fromDupe.includes("7902086725805"), "duplicate itself included");
});

test("shopifyIdsFoldingInto never returns duplicates in the list", () => {
  const ids = shopifyIdsFoldingInto("7497753460909");
  assert.equal(ids.length, new Set(ids).size);
});

test("no alias points at another alias — a two-hop fold would strand reviews", () => {
  for (const target of Object.values(SHOPIFY_PRODUCT_ALIASES)) {
    assert.equal(
      SHOPIFY_PRODUCT_ALIASES[target],
      undefined,
      `alias target ${target} is itself an alias — fold must be one hop`,
    );
  }
});
