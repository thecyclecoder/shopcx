import { test } from "node:test";
import assert from "node:assert/strict";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run.js";

const KCUPS = "gid://shopify/Product/7467749965997";
const CREAMER = "gid://shopify/Product/7467657887917";
const CINNAMON = "gid://shopify/ProductVariant/43512521523373";
const PLAN = { sellingPlan: { id: "gid://shopify/SellingPlan/1" } };

const kcups = (quantity, sub = false) => ({
  id: "gid://shopify/CartLine/kcups",
  quantity,
  giftTag: null,
  sellingPlanAllocation: sub ? PLAN : null,
  merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/42618778189997", product: { id: KCUPS } },
});
const creamer = ({ tagged = true, sub = false, quantity = 1, id = "gid://shopify/CartLine/gift" } = {}) => ({
  id,
  quantity,
  giftTag: tagged ? { value: "cinnamon-roll-creamer" } : null,
  sellingPlanAllocation: sub ? PLAN : null,
  merchandise: { __typename: "ProductVariant", id: CINNAMON, product: { id: CREAMER } },
});
const run = (lines, discountClasses = ["PRODUCT"]) =>
  cartLinesDiscountsGenerateRun({ cart: { lines }, discount: { discountClasses, metafield: null } });
const freedLine = (result) => result.operations[0]?.productDiscountsAdd.candidates[0].targets[0].cartLine;

test("one-time single box does not qualify", () => {
  assert.deepEqual(run([kcups(1), creamer()]).operations, []);
});

test("one-time 2 boxes frees one unit of the gift line", () => {
  assert.deepEqual(freedLine(run([kcups(2), creamer()])), { id: "gid://shopify/CartLine/gift", quantity: 1 });
});

test("single-box subscription qualifies", () => {
  assert.ok(freedLine(run([kcups(1, true), creamer()])));
});

test("untagged creamer the shopper bought is never freed", () => {
  assert.deepEqual(run([kcups(2), creamer({ tagged: false })]).operations, []);
});

test("creamer on a subscription is never freed", () => {
  assert.deepEqual(run([kcups(2, true), creamer({ sub: true })]).operations, []);
});

test("picks the tagged gift line over a paid creamer line", () => {
  const lines = [kcups(1, true), creamer({ tagged: false, id: "paid" }), creamer({ id: "gift" })];
  assert.equal(freedLine(run(lines)).id, "gift");
});

test("no gift line, no discount", () => {
  assert.deepEqual(run([kcups(3)]).operations, []);
});

test("does nothing without the PRODUCT discount class", () => {
  assert.deepEqual(run([kcups(2), creamer()], ["ORDER"]).operations, []);
});

test("metafield config overrides the minimum quantity", () => {
  const result = cartLinesDiscountsGenerateRun({
    cart: { lines: [kcups(2), creamer()] },
    discount: { discountClasses: ["PRODUCT"], metafield: { jsonValue: { minQuantity: 3 } } },
  });
  assert.deepEqual(result.operations, []);
});
