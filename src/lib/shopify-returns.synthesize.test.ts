/**
 * Unit test for `synthesizeReturnItemsFromLines` — the pure line→return-item mapping that
 * createFullReturn now ALWAYS uses (founder decision, 2026-07: always synthesize our own return
 * from the order's line_items, never Shopify's return object).
 *
 * Pins the fix for the malformed $6-only returns (Amy SC133495, Kim SC134360): the return must
 * capture EVERY product line (the tabs), not just the Shipping Protection line Shopify's return
 * API would accept before fulfillment.
 *
 * Run:
 *   npx tsx --test src/lib/shopify-returns.synthesize.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { synthesizeReturnItemsFromLines } from "./shopify-returns";

// Kim's real SC134360 line_items shape (Shopify order paid via Shopify Payments).
const SC134360_LINES = [
  { sku: "SC-TABS-SL-2", title: "Superfood Tabs", quantity: 2, variant_id: "42614433480877", price_cents: 5996, variant_title: "Strawberry Lemonade" },
  { sku: "Insure01", title: "Shipping Protection", quantity: 1, variant_id: "42898153898157", price_cents: 600, variant_title: null },
];

test("captures ALL product lines (not just Shipping Protection) — the core fix", () => {
  const items = synthesizeReturnItemsFromLines(SC134360_LINES);
  assert.equal(items.length, 2);
  const titles = items.map((i) => i.title);
  assert.ok(titles.includes("Superfood Tabs — Strawberry Lemonade"), "the tabs line must be present");
  assert.ok(titles.includes("Shipping Protection"), "the protection line is still present");
});

test("amountCents is per-unit price × quantity (line total)", () => {
  const items = synthesizeReturnItemsFromLines(SC134360_LINES);
  const tabs = items.find((i) => i.title.startsWith("Superfood Tabs"))!;
  assert.equal(tabs.amountCents, 11992); // 5996 × 2
  const prot = items.find((i) => i.title === "Shipping Protection")!;
  assert.equal(prot.amountCents, 600); // 600 × 1
  // Full line subtotal = $125.92 — the returnable value that used to be shorted to $6.
  assert.equal(items.reduce((s, i) => s + i.amountCents, 0), 12592);
});

test("variant_title composes into the title; null variant_title leaves the bare title", () => {
  const items = synthesizeReturnItemsFromLines(SC134360_LINES);
  assert.equal(items[0].title, "Superfood Tabs — Strawberry Lemonade");
  assert.equal(items[1].title, "Shipping Protection");
});

test("variant_id is stringified (accepts number or string); missing → null", () => {
  const items = synthesizeReturnItemsFromLines([
    { title: "A", quantity: 1, price_cents: 100, variant_id: 42614433480877 },
    { title: "B", quantity: 1, price_cents: 100 },
  ]);
  assert.equal(items[0].variantId, "42614433480877");
  assert.equal(items[1].variantId, null);
});

test("drops zero / negative quantity lines", () => {
  const items = synthesizeReturnItemsFromLines([
    { title: "Keep", quantity: 1, price_cents: 100 },
    { title: "Zero", quantity: 0, price_cents: 100 },
    { title: "Neg", quantity: -1, price_cents: 100 },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Keep");
});

test("no Shopify reverse-fulfillment line id (we create no Shopify return)", () => {
  const items = synthesizeReturnItemsFromLines(SC134360_LINES);
  assert.ok(items.every((i) => i.fulfillmentLineItemId === ""));
});

test("null / empty / undefined input → []", () => {
  assert.deepEqual(synthesizeReturnItemsFromLines(null), []);
  assert.deepEqual(synthesizeReturnItemsFromLines(undefined), []);
  assert.deepEqual(synthesizeReturnItemsFromLines([]), []);
});
