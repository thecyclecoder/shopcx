/**
 * Appstle promo-line flags → migration treatment. Ground truth: every flagged line in the
 * stored contract snapshots is the $0 ACV Gummies bonus carrying BOTH attributes, which the
 * migration used to carry over as a PAID recurring line (sub 25afd98d, $27.57 on SHOPCX426).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appstlePromoFlags } from "./migrate-to-internal";

const attr = (key: string, value: string) => ({ key, value, __typename: "Attribute" });

test("ground-truth ACV bonus line → free + one-time (never carried over)", () => {
  const line = {
    title: "ACV Gummies",
    currentPrice: { amount: "0.0" },
    pricingPolicy: null,
    customAttributes: [attr("_appstle-free-product", "true"), attr("_appstle-one-time-product", "true")],
  };
  assert.deepEqual(appstlePromoFlags(line), { freeProduct: true, oneTime: true });
});

test("free-only line → recurring free gift", () => {
  assert.deepEqual(
    appstlePromoFlags({ customAttributes: [attr("_appstle-free-product", "true")] }),
    { freeProduct: true, oneTime: false },
  );
});

test("regular paid line (no attributes / other attributes / false values) → no flags", () => {
  const none = { freeProduct: false, oneTime: false };
  assert.deepEqual(appstlePromoFlags({}), none);
  assert.deepEqual(appstlePromoFlags({ customAttributes: null }), none);
  assert.deepEqual(appstlePromoFlags({ customAttributes: [attr("_some-other", "true")] }), none);
  assert.deepEqual(
    appstlePromoFlags({ customAttributes: [attr("_appstle-free-product", "false"), attr("_appstle-one-time-product", "false")] }),
    none,
  );
});

test("value matching is case-insensitive ('TRUE')", () => {
  assert.equal(appstlePromoFlags({ customAttributes: [attr("_appstle-one-time-product", "TRUE")] }).oneTime, true);
});
