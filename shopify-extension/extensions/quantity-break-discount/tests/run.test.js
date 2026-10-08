import { test } from "node:test";
import assert from "node:assert/strict";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run.js";

const KCUPS = "gid://shopify/Product/7467749965997";
const CREAMER = "gid://shopify/Product/7467657887917";
const PROTECTION = "gid://shopify/Product/8356945952941";

const line = (id, product, quantity = 1, gift = false) => ({
  id,
  quantity,
  giftTag: gift ? { value: "cinnamon-roll-creamer" } : null,
  merchandise: { __typename: "ProductVariant", product: { id: product } },
  sellingPlanAllocation: null,
});
const run = (lines, config = null, discountClasses = ["PRODUCT"]) =>
  cartLinesDiscountsGenerateRun({
    cart: { lines },
    discount: { discountClasses, metafield: config ? { jsonValue: config } : null },
  });
const candidate = (result) => result.operations[0]?.productDiscountsAdd.candidates[0];

test("one unit gets nothing", () => {
  assert.deepEqual(run([line("a", KCUPS)]).operations, []);
});

test("two units across products get 8% on every eligible line", () => {
  const c = candidate(run([line("a", KCUPS), line("b", CREAMER), line("p", PROTECTION)]));
  assert.equal(c.message, "Buy 2 Discount");
  assert.deepEqual(c.value, { percentage: { value: 8 } });
  assert.deepEqual(c.targets.map((t) => t.cartLine.id), ["a", "b"]);
});

test("free gift creamer does not unlock Buy 2", () => {
  assert.deepEqual(run([line("a", KCUPS), line("g", CREAMER, 1, true)]).operations, []);
});

test("free gift creamer does not bump 2 boxes into Buy 3", () => {
  const tier3 = { minQuantity: 3, percentage: 12 };
  assert.deepEqual(run([line("a", KCUPS, 2), line("g", CREAMER, 1, true)], tier3).operations, []);
  const c = candidate(run([line("a", KCUPS, 2), line("g", CREAMER, 1, true)]));
  assert.deepEqual(c.targets.map((t) => t.cartLine.id), ["a"]);
});

test("Buy 3 tier from metafield config", () => {
  const c = candidate(run([line("a", KCUPS, 3)], { minQuantity: 3, percentage: 12 }));
  assert.equal(c.message, "Buy 3 Discount");
  assert.deepEqual(c.value, { percentage: { value: 12 } });
});

test("does nothing without the PRODUCT discount class", () => {
  assert.deepEqual(run([line("a", KCUPS, 2)], null, ["ORDER"]).operations, []);
});

const SUB = { sellingPlan: { id: "gid://shopify/SellingPlan/1" } };
const sub = (id, product, quantity = 1) => ({ ...line(id, product, quantity), sellingPlanAllocation: SUB });
const OTHER = "gid://shopify/Product/9999";
const SNS = { subscriptionPercentage: 25 };
const values = (result) =>
  Object.fromEntries(
    (result.operations[0]?.productDiscountsAdd.candidates ?? []).flatMap((c) =>
      c.targets.map((t) => [t.cartLine.id, c.value.percentage.value]),
    ),
  );

test("subscriptionPercentage defaults to 0: subscription lines get only the tier", () => {
  assert.deepEqual(values(run([sub("s", KCUPS, 2)])), { s: 8 });
});

test("subscription-only discount (minQuantity 1, percentage 0) gives 25% to sub lines only", () => {
  const cfg = { ...SNS, minQuantity: 1, percentage: 0 };
  const result = run([sub("s", KCUPS), line("o", CREAMER), sub("x", OTHER), sub("p", PROTECTION)], cfg);
  assert.deepEqual(values(result), { s: 25, x: 25 });
  assert.equal(result.operations[0].productDiscountsAdd.candidates[0].message, "Subscription Discount");
  assert.equal(result.operations[0].productDiscountsAdd.selectionStrategy, "ALL");
});

test("Buy 2 stacks after 25% on subscription lines (31%), one-time lines keep 8%", () => {
  assert.deepEqual(values(run([sub("s", KCUPS), line("o", CREAMER)], SNS)), { s: 31, o: 8 });
});

test("Buy 3 stacks after 25% on subscription lines (34%)", () => {
  assert.deepEqual(values(run([sub("s", KCUPS, 3)], { ...SNS, minQuantity: 3, percentage: 12 })), { s: 34 });
});

test("subscription line outside the tier list still gets 25% from a tier discount", () => {
  assert.deepEqual(values(run([sub("s", KCUPS, 2), sub("x", OTHER)], SNS)), { s: 31, x: 25 });
});

test("free gift is never discounted by the subscription part", () => {
  const cfg = { ...SNS, minQuantity: 1, percentage: 0 };
  assert.deepEqual(values(run([sub("s", KCUPS), line("g", CREAMER, 1, true)], cfg)), { s: 25 });
});

test("subscription-only discount covers a sub line with no tier products in the cart", () => {
  assert.deepEqual(values(run([sub("x", OTHER)], { ...SNS, minQuantity: 1, percentage: 0 })), { x: 25 });
});
