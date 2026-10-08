/**
 * classifyShopifyCodeDiscountResponse — only an error-free "no such code" may drop a coupon off
 * a subscription. Ground truth: the renewal used to read every lookup failure as "invalid" and
 * drop the code, so one throttled Shopify call charged full price AND deleted the discount.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyShopifyCodeDiscountResponse as classify } from "./coupons";

test("HTTP error → unavailable (never 'invalid')", () => {
  assert.equal(classify(false, null).kind, "unavailable");
});

test("GraphQL THROTTLED → unavailable", () => {
  assert.equal(
    classify(true, { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], data: null }).kind,
    "unavailable",
  );
});

test("errors alongside partial data → unavailable", () => {
  assert.equal(classify(true, { errors: [{ message: "Internal error" }], data: { codeDiscountNodeByCode: null } }).kind, "unavailable");
});

test("body without data / non-object body → unavailable", () => {
  assert.equal(classify(true, {}).kind, "unavailable");
  assert.equal(classify(true, "oops").kind, "unavailable");
  assert.equal(classify(true, null).kind, "unavailable");
});

test("error-free null node → not_found (the only case that drops a code)", () => {
  assert.equal(classify(true, { data: { codeDiscountNodeByCode: null } }).kind, "not_found");
  assert.equal(classify(true, { data: { codeDiscountNodeByCode: { codeDiscount: null } } }).kind, "not_found");
});

test("a real node → found, with the codeDiscount payload", () => {
  const r = classify(true, { data: { codeDiscountNodeByCode: { codeDiscount: { customerGets: { value: { percentage: 0.1 } } } } } });
  assert.equal(r.kind, "found");
  if (r.kind === "found") assert.deepEqual(r.codeDiscount, { customerGets: { value: { percentage: 0.1 } } });
});
