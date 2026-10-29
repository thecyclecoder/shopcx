/** detectDrift — lines match as a multiset, so a duplicate-SKU contract is not "drifted" forever. */
import test from "node:test";
import assert from "node:assert/strict";
import { detectDrift } from "./shopify-subscription-migrate";

const line = (sku: string, quantity: number, cents: number) =>
  ({ sku, variant_id: null, quantity, current_price_cents: cents, effective_unit_cents: cents }) as never;

test("the same SKU twice (paid + promo line) in any order is not drift", () => {
  const snap = [line("SC-TABS-PM-2", 1, 6929), line("SC-TABS-PM-2", 1, 5197)];
  const fresh = [line("SC-TABS-PM-2", 1, 5197), line("SC-TABS-PM-2", 1, 6929)];
  assert.deepEqual(detectDrift(snap, fresh, "ACTIVE", "ACTIVE"), []);
});
test("a real price change on a duplicate-SKU line is still drift", () => {
  const snap = [line("SC-TABS-PM-2", 1, 6929), line("SC-TABS-PM-2", 1, 5197)];
  const fresh = [line("SC-TABS-PM-2", 1, 6929), line("SC-TABS-PM-2", 1, 4999)];
  assert.deepEqual(detectDrift(snap, fresh, "ACTIVE", "ACTIVE"), ["SC-TABS-PM-2 price 5197 -> 4999"]);
});
test("qty, status, line count and new lines are still caught", () => {
  assert.deepEqual(detectDrift([line("A", 1, 100)], [line("A", 2, 100)], "ACTIVE", "ACTIVE"), ["A qty 1 -> 2"]);
  assert.deepEqual(detectDrift([line("A", 1, 100)], [line("A", 1, 100)], "ACTIVE", "PAUSED"), ["status ACTIVE -> PAUSED"]);
  assert.deepEqual(detectDrift([line("A", 1, 100)], [line("A", 1, 100), line("B", 1, 1)], "ACTIVE", "ACTIVE"), ["line count 1 -> 2"]);
  assert.deepEqual(detectDrift([line("A", 1, 100)], [line("B", 1, 100)], "ACTIVE", "ACTIVE"), ["new line B"]);
});
