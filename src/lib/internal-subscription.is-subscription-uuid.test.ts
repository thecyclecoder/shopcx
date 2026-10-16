/**
 * Pins `isSubscriptionUuid` — the strict UUID guard that gates contract-id → shopify_contract_id
 * resolution at the three action-dispatch sites. A bare `includes("-")` check used to let an
 * already-resolved internal contract id (`internal-<hex>`) flow into the uuid-typed
 * subscriptions.id cast, spamming the Postgres error feed with invalid-uuid errors. This test
 * asserts the exact failure boundary: real UUID accepted, internal-* / numeric id rejected.
 *
 * Run: npx tsx --test src/lib/internal-subscription.is-subscription-uuid.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isSubscriptionUuid } from "./internal-subscription";

test("accepts a real subscription UUID", () => {
  assert.equal(isSubscriptionUuid("3f8c2a1e-9b4d-4c6a-8e21-1a2b3c4d5e6f"), true);
});

test("accepts an uppercase UUID (case-insensitive)", () => {
  assert.equal(isSubscriptionUuid("3F8C2A1E-9B4D-4C6A-8E21-1A2B3C4D5E6F"), true);
});

test("rejects an internal-* contract id (the error-feed culprit)", () => {
  assert.equal(isSubscriptionUuid("internal-9b4d4c6a8e21"), false);
});

test("rejects a numeric Shopify contract id", () => {
  assert.equal(isSubscriptionUuid("1234567890"), false);
});

test("rejects a bare dash string that the old includes('-') guard let through", () => {
  assert.equal(isSubscriptionUuid("gid://shopify/SubscriptionContract/123"), false);
});
