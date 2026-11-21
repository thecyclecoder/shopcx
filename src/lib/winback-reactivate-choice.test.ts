import { test } from "node:test";
import assert from "node:assert/strict";
import { winbackChoiceFrom } from "./winback-reactivate-choice";

test("minted win-back session (no journeyType) + Yes → reactivate", () => {
  assert.equal(winbackChoiceFrom(null, { reactivate_choice: { value: "reactivate" } }), "reactivate");
});
test("win-back journey type + Not now → not_now", () => {
  assert.equal(winbackChoiceFrom("reactivate_subscription", { reactivate_choice: { value: "not_now" } }), "not_now");
});
test("other journey with a stray key is ignored", () => {
  assert.equal(winbackChoiceFrom("cancel_subscription", { reactivate_choice: { value: "reactivate" } }), null);
});
test("no choice → null", () => {
  assert.equal(winbackChoiceFrom("win_back", {}), null);
  assert.equal(winbackChoiceFrom(null, null), null);
});

import { parseReactivateValue, giftOptionValue } from "./reactivate-journey-builder";

test("plain restart value", () => {
  assert.deepEqual(parseReactivateValue("reactivate"), { restart: true, giftVariantId: null });
});
test("restart + gift round-trips the variant id", () => {
  const v = "e3953a24-c060-41e7-9ca4-06a481df236b";
  assert.deepEqual(parseReactivateValue(giftOptionValue(v)), { restart: true, giftVariantId: v });
});
test("not_now is not a restart", () => {
  assert.deepEqual(parseReactivateValue("not_now"), { restart: false, giftVariantId: null });
});
