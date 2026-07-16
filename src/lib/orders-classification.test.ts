/**
 * orders-classification — Phase 1 verification.
 *
 * Fixture-pins classifyOrder against a curated row-set spanning all three
 * sources × renewal/checkout × sub/one_time, and grep-guards that the SDK
 * still delegates the renewal/subscription predicate to bucketOrder (so a
 * silent drift in that classifier fails this build, not ROAS reporting).
 *
 * The spec suggests vitest; the repo's convention is node:test via tsx:
 *   npx tsx --test src/lib/orders-classification.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { classifyOrder } from "./orders-classification";

// ── source × origin × cartType fixture table ──
// Each row is a real-shaped orders slice; the expected verdict is what the
// callers currently hand-roll (or should — the whole point of the SDK).

type Fixture = {
  name: string;
  row: Parameters<typeof classifyOrder>[0];
  expected: ReturnType<typeof classifyOrder>;
};

const FIXTURES: Fixture[] = [
  // ── SHOPIFY ──
  {
    name: "shopify subscription renewal (subscription_contract)",
    row: { source_name: "subscription_contract", shopify_order_id: "5555555555" },
    expected: { source: "shopify", origin: "renewal", cartType: undefined },
  },
  {
    name: "shopify subscription renewal (subscription_contract_checkout_one)",
    row: { source_name: "subscription_contract_checkout_one", shopify_order_id: "5555555556" },
    expected: { source: "shopify", origin: "renewal", cartType: undefined },
  },
  {
    name: "shopify checkout that created a subscription (first-subscription tag)",
    row: {
      source_name: "web",
      shopify_order_id: "5555555557",
      tags: "first subscription, foo",
      subscription_id: "sub-abc",
    },
    expected: { source: "shopify", origin: "checkout", cartType: "subscription" },
  },
  {
    name: "shopify one-time checkout (web, no sub tag)",
    row: { source_name: "web", shopify_order_id: "5555555558", tags: "loyalty" },
    expected: { source: "shopify", origin: "checkout", cartType: "one_time" },
  },
  {
    name: "shopify draft/replacement order",
    row: { source_name: "shopify_draft_order", shopify_order_id: "5555555559" },
    expected: { source: "shopify", origin: "checkout", cartType: undefined },
  },

  // ── INTERNAL ──
  {
    name: "internal subscription renewal (internal_subscription_renewal → renewal)",
    row: {
      source_name: "internal_subscription_renewal",
      braintree_transaction_id: "bt-txn-1",
      subscription_id: "sub-int-1",
    },
    expected: { source: "internal", origin: "renewal", cartType: undefined },
  },
  {
    name: "internal comp renewal (internal_subscription_comp_renewal → renewal)",
    row: {
      source_name: "internal_subscription_comp_renewal",
      subscription_id: "sub-int-2",
    },
    expected: { source: "internal", origin: "renewal", cartType: undefined },
  },
  {
    name: "internal storefront one-time (bare storefront order → checkout/one_time)",
    row: { source_name: "storefront" },
    expected: { source: "internal", origin: "checkout", cartType: "one_time" },
  },
  {
    name: "internal storefront checkout that joined a sub (subscription_id set)",
    row: { source_name: "storefront", subscription_id: "sub-int-3" },
    expected: { source: "internal", origin: "checkout", cartType: "subscription" },
  },
  {
    name: "internal fallback — braintree charge, no shopify_order_id, no source_name",
    row: { braintree_transaction_id: "bt-txn-2" },
    expected: { source: "internal", origin: "checkout", cartType: "one_time" },
  },

  // ── AMAZON ──
  {
    name: "amazon one-time checkout (source_name=amazon)",
    row: { source_name: "amazon", amazon_order_id: "111-1111111-1111111" },
    expected: { source: "amazon", origin: "checkout", cartType: "one_time" },
  },
  {
    name: "amazon by amazon_order_id alone",
    row: { amazon_order_id: "111-2222222-2222222" },
    expected: { source: "amazon", origin: "checkout", cartType: "one_time" },
  },
];

for (const fx of FIXTURES) {
  test(`classifyOrder — ${fx.name}`, () => {
    const got = classifyOrder(fx.row);
    assert.equal(got.source, fx.expected.source, "source");
    assert.equal(got.origin, fx.expected.origin, "origin");
    assert.equal(got.cartType, fx.expected.cartType, "cartType");
    // Phase 1: customerRecency is always undefined — Phase 2 fills it.
    assert.equal(got.customerRecency, undefined, "customerRecency (Phase 1 always undefined)");
  });
}

test("customerRecency is never populated in Phase 1 (checkout OR renewal)", () => {
  // Explicit invariant so a future partial-Phase-2 sneak-in fails here first.
  const rows: Parameters<typeof classifyOrder>[0][] = [
    { source_name: "web", shopify_order_id: "1" },
    { source_name: "storefront" },
    { source_name: "internal_subscription_renewal" },
    { source_name: "amazon" },
  ];
  for (const r of rows) {
    assert.equal(classifyOrder(r).customerRecency, undefined);
  }
});

test("respects workspaces.order_source_mapping (passes through to bucketOrder)", () => {
  // A workspace can map a custom source_name to "recurring" or "replacement".
  const mapping = { my_custom_renewal: "recurring", my_custom_draft: "replacement" };
  assert.equal(
    classifyOrder({ source_name: "my_custom_renewal" }, { sourceMapping: mapping }).origin,
    "renewal",
  );
  assert.equal(
    classifyOrder({ source_name: "my_custom_draft" }, { sourceMapping: mapping }).cartType,
    undefined,
  );
});

// ── grep guards: reuse bucketOrder, never re-derive the renewal predicate ──

const SDK_SOURCE = fs.readFileSync(
  path.join(__dirname, "orders-classification.ts"),
  "utf8",
);

test("orders-classification.ts imports bucketOrder from ./order-bucketing (no re-implementation)", () => {
  // Must delegate origin/cartType to the SoT classifier.
  assert.match(
    SDK_SOURCE,
    /from\s+["']\.\/order-bucketing["']/,
    "orders-classification.ts must import from ./order-bucketing",
  );
  assert.match(
    SDK_SOURCE,
    /\bbucketOrder\b/,
    "orders-classification.ts must call bucketOrder",
  );
});

test("orders-classification.ts contains no inline `source_name.includes(\"subscription\")` re-derivation", () => {
  // Anyone re-implementing bucketOrder's renewal predicate here would drift
  // ROAS silently — the grep guard fails the build on it.
  assert.doesNotMatch(
    SDK_SOURCE,
    /source_name\s*(?:\?\.)?\s*\.\s*includes\s*\(\s*["']subscription["']\s*\)/,
    "orders-classification.ts must delegate to bucketOrder — no inline subscription re-derivation",
  );
});
