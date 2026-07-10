/**
 * Unit tests for buildOneTimeGiftItem — the internal one-time gift/add-on record.
 * A gift must ride exactly ONE renewal (one_time_next_renewal) and be $0 (is_gift).
 *
 * Run:
 *   npx tsx --test src/lib/internal-subscription.oneTimeGift.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildOneTimeGiftItem } from "./internal-subscription";

const RESOLVED = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  product_id: "prod-1",
  title: "Handheld Drink Mixer",
  variant_title: "",
  sku: "SC-FROTHER",
};

test("free gift → is_gift + one_time_next_renewal, no price override", () => {
  const item = buildOneTimeGiftItem(RESOLVED, "ignored", 1, { free: true });
  assert.equal(item.is_gift, true);
  assert.equal(item.one_time_next_renewal, true);
  assert.equal(item.price_override_cents, undefined);
  assert.equal(item.variant_id, RESOLVED.id);
  assert.equal(item.quantity, 1);
  assert.equal(item.title, "Handheld Drink Mixer");
});

test("free is the DEFAULT (opts omitted)", () => {
  const item = buildOneTimeGiftItem(RESOLVED, "ignored", 1);
  assert.equal(item.is_gift, true);
  assert.equal(item.one_time_next_renewal, true);
});

test("paid one-time add with explicit price → override set, NOT a gift", () => {
  const item = buildOneTimeGiftItem(RESOLVED, "ignored", 2, { free: false, priceCents: 1995 });
  assert.equal(item.is_gift, undefined);
  assert.equal(item.one_time_next_renewal, true);
  assert.equal(item.price_override_cents, 1995);
  assert.equal(item.quantity, 2);
});

test("paid one-time add with NO price → no override (pricing engine derives live)", () => {
  const item = buildOneTimeGiftItem(RESOLVED, "ignored", 1, { free: false });
  assert.equal(item.is_gift, undefined);
  assert.equal(item.one_time_next_renewal, true);
  assert.equal(item.price_override_cents, undefined);
});

test("unresolved variant → falls back to the passed id + generic title, still one-time", () => {
  const item = buildOneTimeGiftItem(null, "42614446260397", 1, { free: true });
  assert.equal(item.variant_id, "42614446260397");
  assert.equal(item.title, "Gift");
  assert.equal(item.is_gift, true);
  assert.equal(item.one_time_next_renewal, true);
});

test("quantity is floored to a positive integer", () => {
  assert.equal(buildOneTimeGiftItem(RESOLVED, "x", 0, { free: true }).quantity, 1);
  assert.equal(buildOneTimeGiftItem(RESOLVED, "x", 3.9, { free: true }).quantity, 3);
  assert.equal(buildOneTimeGiftItem(RESOLVED, "x", -5, { free: true }).quantity, 1);
});

test("negative price is clamped to 0", () => {
  const item = buildOneTimeGiftItem(RESOLVED, "x", 1, { free: false, priceCents: -100 });
  assert.equal(item.price_override_cents, 0);
});
