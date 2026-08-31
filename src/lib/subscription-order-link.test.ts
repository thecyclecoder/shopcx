/**
 * Pins the matching rules for subscription → originating-order linkage.
 *
 * The wedge: a subscription's FIRST order arrives as source_name="web" with a
 * "first subscription" tag — NOT source_name="subscription_contract". The old
 * webhook gate only accepted the latter, so ~1,000 first orders since April
 * 2026 were left with a NULL orders.subscription_id.
 *
 * Run: npx tsx --test src/lib/subscription-order-link.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseOrderForSubscription,
  isFirstSubscriptionOrder,
  orderSkus,
  tagTokens,
  type LinkCandidateOrder,
} from "./subscription-order-link";

const order = (o: Partial<LinkCandidateOrder> & { id: string }): LinkCandidateOrder => ({
  created_at: "2026-07-01T12:00:00Z",
  tags: "first subscription",
  source_name: "web",
  line_items: [],
  ...o,
});

test("the real first-order shape is recognised — web + first-subscription tag", () => {
  assert.equal(isFirstSubscriptionOrder({ source_name: "web", tags: "first subscription" }), true);
  // Shopify joins tags with commas and varies case.
  assert.equal(isFirstSubscriptionOrder({ source_name: "web", tags: "VIP, First Subscription, wholesale" }), true);
  assert.equal(isFirstSubscriptionOrder({ source_name: "web", tags: ["vip", "First subscription"] }), true);
});

test("internal storefront orders count — they carry no Shopify tag", () => {
  assert.equal(isFirstSubscriptionOrder({ source_name: "storefront", tags: null }), true);
});

test("a plain one-time checkout is NOT a first-subscription order", () => {
  assert.equal(isFirstSubscriptionOrder({ source_name: "web", tags: null }), false);
  assert.equal(isFirstSubscriptionOrder({ source_name: "web", tags: "vip,wholesale" }), false);
});

test("tagTokens survives Shopify's comma string and arrays", () => {
  assert.deepEqual(tagTokens("A, b ,C"), ["a", "b", "c"]);
  assert.deepEqual(tagTokens(["A", " b "]), ["a", "b"]);
  assert.deepEqual(tagTokens(null), []);
  assert.deepEqual(tagTokens(""), []);
});

test("orderSkus pulls and trims line-item SKUs", () => {
  assert.deepEqual([...orderSkus([{ sku: "TABS-30" }, { sku: " COFFEE " }, { sku: "" }, {}])], ["TABS-30", "COFFEE"]);
  assert.deepEqual([...orderSkus(null)], []);
});

test("SKU overlap wins even when several candidates exist", () => {
  const res = chooseOrderForSubscription(
    [
      order({ id: "wrong", line_items: [{ sku: "COFFEE" }] }),
      order({ id: "right", line_items: [{ sku: "TABS-30" }] }),
    ],
    [{ sku: "TABS-30" }],
  );
  assert.equal(res.linked, true);
  assert.equal(res.orderId, "right");
  assert.equal(res.reason, "sku_match");
});

test("a sole candidate links even with no SKU information", () => {
  const res = chooseOrderForSubscription([order({ id: "only", line_items: [] })], []);
  assert.equal(res.linked, true);
  assert.equal(res.orderId, "only");
  assert.equal(res.reason, "sole_candidate");
});

test("ambiguity is left UNLINKED rather than guessed", () => {
  // Two first-sub orders, neither matching the subscription's SKU: a wrong link
  // corrupts both bucketing and the subscription's order history, so we abstain.
  const res = chooseOrderForSubscription(
    [
      order({ id: "a", line_items: [{ sku: "COFFEE" }] }),
      order({ id: "b", line_items: [{ sku: "CREAMER" }] }),
    ],
    [{ sku: "TABS-30" }],
  );
  assert.equal(res.linked, false);
  assert.equal(res.reason, "ambiguous");
  assert.equal(res.candidatesConsidered, 2);
});

test("non-subscription orders in the window are ignored entirely", () => {
  const res = chooseOrderForSubscription(
    [
      order({ id: "onetime", tags: "vip", source_name: "web", line_items: [{ sku: "TABS-30" }] }),
      order({ id: "thesub", line_items: [{ sku: "TABS-30" }] }),
    ],
    [{ sku: "TABS-30" }],
  );
  assert.equal(res.orderId, "thesub", "the untagged one-time order must not win on SKU alone");
});

test("no eligible candidate reports no_candidate", () => {
  const res = chooseOrderForSubscription([order({ id: "x", tags: "vip", source_name: "web" })], [{ sku: "TABS-30" }]);
  assert.equal(res.linked, false);
  assert.equal(res.reason, "no_candidate");
});

test("two orders sharing the SKU resolve to the earliest", () => {
  const res = chooseOrderForSubscription(
    [
      order({ id: "later", created_at: "2026-07-02T00:00:00Z", line_items: [{ sku: "TABS-30" }] }),
      order({ id: "earlier", created_at: "2026-07-01T00:00:00Z", line_items: [{ sku: "TABS-30" }] }),
    ],
    [{ sku: "TABS-30" }],
  );
  assert.equal(res.orderId, "earlier");
  assert.equal(res.reason, "sku_match");
});

test("subscription items with blank SKUs fall through to the sole-candidate rule", () => {
  const res = chooseOrderForSubscription([order({ id: "only" })], [{ sku: "" }, { sku: null }]);
  assert.equal(res.linked, true);
  assert.equal(res.reason, "sole_candidate");
});
