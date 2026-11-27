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

import { parseReactivateValue, giftOptionValue, REACTIVATE_REPLACE_VALUE } from "./reactivate-journey-builder";

test("plain restart value", () => {
  assert.deepEqual(parseReactivateValue("reactivate"), { restart: true, giftVariantId: null, replaceDiscontinued: false });
});
test("restart + gift round-trips the variant id", () => {
  const v = "e3953a24-c060-41e7-9ca4-06a481df236b";
  assert.deepEqual(parseReactivateValue(giftOptionValue(v)), { restart: true, giftVariantId: v, replaceDiscontinued: false });
});
test("restart-with-replacement value is flagged", () => {
  assert.deepEqual(parseReactivateValue(REACTIVATE_REPLACE_VALUE), { restart: true, giftVariantId: null, replaceDiscontinued: true });
});
test("not_now is not a restart", () => {
  assert.deepEqual(parseReactivateValue("not_now"), { restart: false, giftVariantId: null, replaceDiscontinued: false });
});

import { pickTargetSubscription, isProtectionLine, hasRealItems } from "./reactivate-journey-builder";

const protectionOnly = { id: "sp", status: "paused", items: [{ sku: "Insure01", title: "Shipping Protection", price_cents: 395 }] };
const creatine = { id: "cr", status: "cancelled", items: [{ sku: "CRE-BC", title: "Creatine Prime+", price_cents: 4995 }, { sku: "Insure01", title: "Shipping Protection", price_cents: 395 }] };
const coffee = { id: "co", status: "cancelled", items: [{ sku: "KC-COCOA", title: "Amazing Coffee K-Cups", price_cents: 3995 }] };

test("protection line detected case-insensitively by SKU or title", () => {
  assert.equal(isProtectionLine({ sku: "Insure01" }), true);
  assert.equal(isProtectionLine({ sku: "insure02" }), true);
  assert.equal(isProtectionLine({ sku: "X", title: "Shipping Protection" }), true);
  assert.equal(isProtectionLine({ sku: "CRE-BC", title: "Creatine Prime+" }), false);
  assert.equal(hasRealItems(protectionOnly.items), false);
  assert.equal(hasRealItems(creatine.items), true);
});
test("session-bound sub wins over a paused sub (the 11/21 test case)", () => {
  assert.equal(pickTargetSubscription([protectionOnly, coffee, creatine], "cr")?.id, "cr");
});
test("bound id not in the customer's cancelled/paused set falls back", () => {
  assert.equal(pickTargetSubscription([coffee, creatine], "someone-else")?.id, "co");
});
test("fallback never picks a protection-only sub", () => {
  assert.equal(pickTargetSubscription([protectionOnly, coffee])?.id, "co");
  assert.equal(pickTargetSubscription([protectionOnly]), null);
});

import { winbackGiftsLive } from "./reactivate-journey-builder";
test("gift offer stops at its deadline", () => {
  const ends = "2026-12-01T07:59:59Z";
  assert.equal(winbackGiftsLive(ends, new Date("2026-11-30T20:00:00Z")), true);
  assert.equal(winbackGiftsLive(ends, new Date("2026-12-01T08:00:00Z")), false);
  assert.equal(winbackGiftsLive(undefined), true);
});
