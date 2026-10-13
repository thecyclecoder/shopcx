import { test } from "node:test";
import assert from "node:assert/strict";
import { cartDeliveryOptionsDiscountsGenerateRun } from "../src/cart_delivery_options_discounts_generate_run.js";

const PLAN = { sellingPlan: { id: "gid://shopify/SellingPlan/1" } };
const sub = { sellingPlanAllocation: PLAN };
const oneTime = { sellingPlanAllocation: null };
const group = (id, ...titles) => ({
  id,
  deliveryOptions: titles.map((title) => ({ handle: `${id}-${title.toLowerCase()}`, title })),
});
const RATES = group("g1", "Economy", "Standard", "Express");
const run = (lines, groups = [RATES], { discountClasses = ["SHIPPING"], config = null } = {}) =>
  cartDeliveryOptionsDiscountsGenerateRun({
    cart: { lines, deliveryGroups: groups },
    discount: { discountClasses, metafield: config ? { jsonValue: config } : null },
  });
const freed = (result) =>
  result.operations[0]?.deliveryDiscountsAdd.candidates[0].targets.map((t) => t.deliveryOption.handle) ?? [];

test("one-time-only cart gets nothing", () => {
  assert.deepEqual(run([oneTime]).operations, []);
});

test("subscription cart frees Economy only", () => {
  assert.deepEqual(freed(run([sub])), ["g1-economy"]);
});

test("mixed cart (subscription + one-time gift) still frees Economy", () => {
  assert.deepEqual(freed(run([oneTime, sub])), ["g1-economy"]);
});

test("frees Economy in every delivery group", () => {
  assert.deepEqual(freed(run([sub], [RATES, group("g2", "Economy")])), ["g1-economy", "g2-economy"]);
});

test("100% off with a shopper-facing message", () => {
  const candidate = run([sub]).operations[0].deliveryDiscountsAdd.candidates[0];
  assert.deepEqual(candidate.value, { percentage: { value: 100 } });
  assert.equal(candidate.message, "Free shipping with your subscription");
});

test("no Economy option, no discount", () => {
  assert.deepEqual(run([sub], [group("g1", "Standard", "Express")]).operations, []);
});

test("config can change which option titles are free", () => {
  assert.deepEqual(freed(run([sub], [RATES], { config: { optionTitles: ["standard"] } })), ["g1-standard"]);
});

test("does nothing without the SHIPPING discount class", () => {
  assert.deepEqual(run([sub], [RATES], { discountClasses: ["PRODUCT"] }).operations, []);
});
