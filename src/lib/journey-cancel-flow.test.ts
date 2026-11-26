import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCancelFlow } from "./journey-cancel-flow";

// Regression pin for the 11/22 cancel-journey silent-failure (5b19a44c): a cancel session's
// config_snapshot carries journeyType but NOT cancelJourney, so the old
// `config.cancelJourney === true || nextOrderCancel` predicate dropped every confirmed cancel.

test("cancel_subscription snapshot without cancelJourney → true", () => {
  assert.equal(resolveCancelFlow({ journeyType: "cancel_subscription" }, undefined), true);
});

test("cancellation / cancel journey types → true", () => {
  assert.equal(resolveCancelFlow({ journeyType: "cancellation" }, undefined), true);
  assert.equal(resolveCancelFlow({ journeyType: "cancel" }, undefined), true);
});

test("explicit cancelJourney → true", () => {
  assert.equal(resolveCancelFlow({ cancelJourney: true }, undefined), true);
});

test("next-order + cancel_flow → true", () => {
  assert.equal(resolveCancelFlow({ nextOrderJourney: true }, true), true);
});

test("next-order without cancel_flow → false", () => {
  assert.equal(resolveCancelFlow({ nextOrderJourney: true }, undefined), false);
  assert.equal(resolveCancelFlow({ nextOrderJourney: true }, false), false);
});

test("discount_signup + cancel_flow:true → false (client flag can't route a non-cancel session)", () => {
  assert.equal(resolveCancelFlow({ journeyType: "discount_signup" }, true), false);
});

test("account_linking → false", () => {
  assert.equal(resolveCancelFlow({ journeyType: "account_linking" }, undefined), false);
  assert.equal(resolveCancelFlow({ journeyType: "account_linking" }, true), false);
});
