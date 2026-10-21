/**
 * Portal Order Now on a ShopCX contract must advance by the customer's OWN cadence.
 *
 * Ground truth 2026-10-20, contract 36109058221 (4-week): `resolveSub` selected no cadence
 * columns, so the handler fell back to "month"/1 and moved the date 11-16 → 12-16 while Shopify
 * stayed on 11-16. These pins fail if either the select or the advance loses the cadence.
 *
 * Run: `npx tsx --test src/lib/portal/order-now-cadence.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextDateAfterCharge } from "../dunning";

const helpers = readFileSync(join(__dirname, "helpers.ts"), "utf8");
const handler = readFileSync(join(__dirname, "handlers/order-now.ts"), "utf8");

test("resolveSub selects the cadence columns the advance needs", () => {
  const select = helpers.match(/from\("subscriptions"\)\s*\.select\("([^"]+)"\)/);
  assert.ok(select, "resolveSub's subscriptions select not found");
  assert.match(select[1], /\bbilling_interval\b/);
  assert.match(select[1], /\bbilling_interval_count\b/);
});

test("the ShopCX advance reads the resolved cadence and syncs Shopify's date", () => {
  assert.match(handler, /resolved\.billing_interval \?\?/);
  assert.match(handler, /resolved\.billing_interval_count \?\?/);
  assert.match(handler, /shopifySetNextBillingDate\(/);
});

test("a 4-week sub pressed early moves 28 days, not a calendar month", () => {
  const due = new Date("2026-11-16T12:00:00Z");
  const now = new Date("2026-10-20T23:39:00Z");
  assert.equal(nextDateAfterCharge(due, now, "week", 4).toISOString(), "2026-12-14T12:00:00.000Z");
  assert.equal(nextDateAfterCharge(due, now, "month", 1).toISOString(), "2026-12-16T12:00:00.000Z");
});
