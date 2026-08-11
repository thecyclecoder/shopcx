/**
 * Pins the lossless-merge invariant in `mergeContractLineItems`.
 *
 * `syncContractItems` runs after EVERY Appstle line mutation, so anything the
 * merge drops is destroyed on the customer's live subscription. The 2026-08-11
 * ACV Gummies sweep is the ground-truth case: the pre-fix sync never mapped
 * `sku`, so a SKU-keyed sweep found 8 subscriptions instead of 307 — every sub
 * touched by a previous mutation had silently lost its skus.
 *
 * Pure function, no I/O — a direct import.
 *
 * Run:
 *   npx tsx --test src/lib/subscription-items.merge.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeContractLineItems } from "./subscription-items";

const node = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/SubscriptionLine/line-a",
  variantId: "gid://shopify/ProductVariant/42618781302957",
  productId: "gid://shopify/Product/7467693047981",
  title: "ACV Gummies",
  variantTitle: "Apple",
  quantity: 2,
  sku: "ST-GUMMY-3",
  sellingPlanName: "Delivered Monthly",
  currentPrice: { amount: "29.96" },
  variantImage: { url: "https://cdn.example/acv.jpg" },
  ...over,
});

test("sku is mapped off the Appstle node (the field whose loss hid 299 subscriptions)", () => {
  const [item] = mergeContractLineItems([], [node()]);
  assert.equal(item.sku, "ST-GUMMY-3");
});

test("selling plan and variant image are mapped too", () => {
  const [item] = mergeContractLineItems([], [node()]);
  assert.equal(item.selling_plan, "Delivered Monthly");
  assert.equal(item.image_url, "https://cdn.example/acv.jpg");
});

test("gids are reduced to bare ids", () => {
  const [item] = mergeContractLineItems([], [node()]);
  assert.equal(item.line_id, "line-a");
  assert.equal(item.variant_id, "42618781302957");
  assert.equal(item.product_id, "7467693047981");
});

test("price is converted to cents", () => {
  const [item] = mergeContractLineItems([], [node()]);
  assert.equal(item.price_cents, 2996);
});

test("local-only fields survive the merge (is_gift / price_override_cents decide what the customer is charged)", () => {
  const prior = [{ line_id: "line-a", is_gift: true, price_override_cents: 1995, one_time_next_renewal: true }];
  const [item] = mergeContractLineItems(prior, [node()]);
  assert.equal(item.is_gift, true);
  assert.equal(item.price_override_cents, 1995);
  assert.equal(item.one_time_next_renewal, true);
});

test("Appstle wins on the fields it owns, even when a prior value disagrees", () => {
  const prior = [{ line_id: "line-a", quantity: 99, price_cents: 1, title: "Stale Title" }];
  const [item] = mergeContractLineItems(prior, [node()]);
  assert.equal(item.quantity, 2);
  assert.equal(item.price_cents, 2996);
  assert.equal(item.title, "ACV Gummies");
});

test("two lines of the SAME variant keep their own local fields (line_id keying, not variant_id)", () => {
  // The 7 subs carrying duplicate ACV lines. A variant-keyed merge would copy
  // line-a's gift flag onto line-b.
  const prior = [
    { line_id: "line-a", is_gift: true },
    { line_id: "line-b", is_gift: false, price_override_cents: 500 },
  ];
  const merged = mergeContractLineItems(prior, [
    node({ id: "gid://shopify/SubscriptionLine/line-a" }),
    node({ id: "gid://shopify/SubscriptionLine/line-b" }),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].is_gift, true);
  assert.equal(merged[0].price_override_cents, undefined);
  assert.equal(merged[1].is_gift, false);
  assert.equal(merged[1].price_override_cents, 500);
});

test("a line Appstle no longer returns is dropped (removal is the whole point)", () => {
  const prior = [{ line_id: "line-a" }, { line_id: "line-gone", sku: "OLD" }];
  const merged = mergeContractLineItems(prior, [node()]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].line_id, "line-a");
});

test("a brand-new line with no prior match still maps cleanly", () => {
  const merged = mergeContractLineItems([{ line_id: "other" }], [node()]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sku, "ST-GUMMY-3");
  assert.equal(merged[0].is_gift, undefined);
});

test("a missing sku on the node yields null, not the string 'undefined'", () => {
  const [item] = mergeContractLineItems([], [node({ sku: undefined })]);
  assert.equal(item.sku, null);
});

test("empty inputs do not throw", () => {
  assert.deepEqual(mergeContractLineItems([], []), []);
});
