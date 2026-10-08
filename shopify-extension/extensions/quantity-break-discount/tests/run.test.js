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
