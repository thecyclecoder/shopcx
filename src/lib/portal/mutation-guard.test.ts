/**
 * Unit tests for the PURE decideMutationGate() decision logic (the pure core
 * of canMutateSubscription — DB read + EasyPost side effect stay in the outer
 * function). Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/portal/mutation-guard.test.ts
 *
 * Focus: the three defects the portal-first-delivery-gate spec (Phase 1) fixes.
 * (1) renewal short-circuit — a sub with >1 order is past first delivery.
 * (2) internal-vs-Shopify branch keys on the ORDER's shopify_order_id, NOT the
 *     sub's is_internal flag (migrated subs are is_internal=true with SC-numbered
 *     Shopify orders and used to fall through to the EasyPost path forever).
 * (3) universal setup-grace age gate — a first order older than SETUP_GRACE_MS
 *     (5 days) unlocks the sub UNCONDITIONALLY, regardless of tracking or
 *     fulfillment_status. Internal orders routinely carry neither (some never
 *     import to Amplifier), so an age-only gate is the only thing that keeps them
 *     from being trapped in the "being set up" banner forever. (CEO 2026-07-23.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideMutationGate, MUTATION_GATED_ROUTES, type GateOrder } from "./mutation-guard";

// Phase 2 — MUTATION_GATED_ROUTES expansion. All keys must be lowercase because
// the portal dispatcher normalizes `route` via .toLowerCase() before the gate
// check runs (src/app/api/portal/route.ts:119).
test("MUTATION_GATED_ROUTES gates every subscription-mutating route named in the spec (Phase 2)", () => {
  const required = [
    // Existing (Phase 1 set) — must survive the expansion.
    "replacevariants", "replace_variants",
    "removelineitem", "remove_line_item",
    "coupon",
    "frequency",
    "changedate", "change_date",
    "shippingprotection", "shipping_protection",
    "loyaltyapplytosubscription", "loyalty_apply_to_subscription",
    // Phase 2 additions — the full spec-named list.
    "cancel",
    "pause",
    "resume",
    "reactivate",
    "canceljourney", "cancel_journey",
    "ordernow", "order_now",
    "updatepaymentmethod", "update_payment_method",
    "setsubscriptionpaymentmethod", "set_subscription_payment_method",
    "address",
  ];
  for (const key of required) {
    assert.equal(MUTATION_GATED_ROUTES.has(key), true, `MUTATION_GATED_ROUTES missing "${key}" (Phase 2 verification bullet 3)`);
    assert.equal(key, key.toLowerCase(), `"${key}" must be lowercase — the dispatcher lowercases the incoming route before matching`);
  }
});

const NOW = new Date("2026-07-06T12:00:00Z").getTime();

// Default age is INSIDE the setup window (1 day) so the deny/lookup branches
// under test aren't pre-empted by the universal age gate; tests that exercise
// the age gate set `created_at` explicitly.
const baseOrder = (overrides: Partial<GateOrder> = {}): GateOrder => ({
  id: "order-1",
  created_at: new Date(NOW - 1 * 24 * 3600 * 1000).toISOString(),
  fulfillment_status: null,
  delivered_at: null,
  easypost_status: null,
  easypost_checked_at: null,
  amplifier_tracking_number: null,
  amplifier_carrier: null,
  shopify_order_id: null,
  ...overrides,
});

test("renewal short-circuit: sub with >1 order is allowed with NO easypost_lookup, regardless of first-order shape", () => {
  const first = baseOrder({
    shopify_order_id: null,
    amplifier_tracking_number: "TRACK123",
    delivered_at: null,
  });
  const d = decideMutationGate(first, 2, NOW);
  assert.equal(d.kind, "allow");
  if (d.kind === "allow") assert.equal(d.state, "delivered");
});

test("Shopify branch: single-order sub whose one order has shopify_order_id + fulfilled → allowed via Shopify path (no easypost_lookup)", () => {
  const first = baseOrder({
    shopify_order_id: "9999",
    fulfillment_status: "fulfilled",
  });
  const d = decideMutationGate(first, 1, NOW);
  assert.equal(d.kind, "allow");
});

test("Shopify branch: single-order Shopify order NOT fulfilled → deny not_shipped (never easypost)", () => {
  const first = baseOrder({
    shopify_order_id: "9999",
    fulfillment_status: null,
  });
  const d = decideMutationGate(first, 1, NOW);
  assert.equal(d.kind, "deny");
  if (d.kind === "deny") assert.equal(d.state, "not_shipped");
});

test("branch keys on ORDER shopify_order_id — a Shopify order stays on Shopify path even if the sub is 'internal'", () => {
  // The sub's is_internal flag is irrelevant to decideMutationGate — the branch
  // is on the ORDER. Migrated subs (is_internal=true + SC-numbered Shopify order)
  // used to fall through to EasyPost forever; this asserts they no longer do.
  const first = baseOrder({
    shopify_order_id: "9999",
    fulfillment_status: "fulfilled",
  });
  const d = decideMutationGate(first, 1, NOW);
  assert.notEqual(d.kind, "easypost_lookup");
});

test("internal single-order + tracking → easypost_lookup (throttled outside)", () => {
  const first = baseOrder({
    shopify_order_id: null,
    amplifier_tracking_number: "TRACK123",
    amplifier_carrier: "USPS",
  });
  const d = decideMutationGate(first, 1, NOW);
  assert.equal(d.kind, "easypost_lookup");
  if (d.kind === "easypost_lookup") {
    assert.equal(d.tracking, "TRACK123");
    assert.equal(d.carrier, "USPS");
  }
});

test("internal single-order + tracking + recent easypost check (in throttle) → deny in_transit (no re-lookup)", () => {
  const first = baseOrder({
    shopify_order_id: null,
    amplifier_tracking_number: "TRACK123",
    easypost_checked_at: new Date(NOW - 5 * 60 * 1000).toISOString(), // 5 min ago
  });
  const d = decideMutationGate(first, 1, NOW);
  assert.equal(d.kind, "deny");
  if (d.kind === "deny") assert.equal(d.state, "in_transit");
});

test("SHOPCX74 case: internal single-order + NO tracking + NO fulfillment_status + >5 days old → allowed via universal age gate", () => {
  // The bug report: a native internal sub (SHOPCX-numbered order, never imported
  // to Amplifier) with empty fulfillments, null fulfillment_status, null tracking.
  // Before the age gate it fell through to deny not_shipped FOREVER.
  const first = baseOrder({
    shopify_order_id: null,
    amplifier_tracking_number: null,
    fulfillment_status: null,
    created_at: new Date(NOW - 16 * 24 * 3600 * 1000).toISOString(),
  });
  const d = decideMutationGate(first, 1, NOW);
  assert.equal(d.kind, "allow");
  if (d.kind === "allow") assert.equal(d.state, "delivered");
});

test("universal age gate wins over the tracking/EasyPost branch: internal + tracking + >5 days → allow (no lookup)", () => {
  // A delivered-but-never-synced internal order: the age gate short-circuits so
  // we don't even need the live EasyPost call to unlock it.
  const first = baseOrder({
    shopify_order_id: null,
    amplifier_tracking_number: "TRACK123",
    created_at: new Date(NOW - 6 * 24 * 3600 * 1000).toISOString(),
  });
  const d = decideMutationGate(first, 1, NOW);
  assert.equal(d.kind, "allow");
});

test("age gate boundary: internal + NO tracking + NOT fulfilled + <5 days old → still deny not_shipped (window not elapsed)", () => {
  const first = baseOrder({
    shopify_order_id: null,
    amplifier_tracking_number: null,
    fulfillment_status: null,
    created_at: new Date(NOW - 3 * 24 * 3600 * 1000).toISOString(),
  });
  const d = decideMutationGate(first, 1, NOW);
  assert.equal(d.kind, "deny");
  if (d.kind === "deny") assert.equal(d.state, "not_shipped");
});

test("already-delivered order (delivered_at set) → allow (cheap path, no lookup)", () => {
  const first = baseOrder({ delivered_at: new Date(NOW - 1000).toISOString() });
  const d = decideMutationGate(first, 1, NOW);
  assert.equal(d.kind, "allow");
});

test("no first order → deny no_order (sub is being set up)", () => {
  const d = decideMutationGate(undefined, 0, NOW);
  assert.equal(d.kind, "deny");
  if (d.kind === "deny") assert.equal(d.state, "no_order");
});
