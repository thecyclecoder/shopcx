/**
 * Unit tests for the money-handler order reference resolver —
 * docs/brain/specs/founder-refund-approval-resolves-order-by-number Phase 1.
 *
 * Ground truth: Nicole Salmon (ticket e0a4f0c8) paid $230.61 for an
 * unshippable order. June raised a founder full_order_refund twice; both
 * failed with 'Missing shopify_order_id' because the promoted remedy carried
 * `order_number`, not `shopify_order_id`. `promoteRecommendedRemedyToExecutable`
 * emits the order ref under whichever of shopify_order_id / order_number /
 * order_id named the order, so the money handlers must accept all three.
 *
 * Run: `npx tsx --test src/lib/action-executor.money-order-ref.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveMoneyOrderRef, moneyOrderMatch } from "./action-executor";

test("a full_order_refund payload of {order_number:'SC141808'} reaches the order lookup instead of failing the missing-ref guard", () => {
  const ref = resolveMoneyOrderRef({ order_number: "SC141808" });
  // Truthy ref → the handler's `if (!ref) return Missing order reference` guard
  // is NOT taken, so the order lookup runs. Before this fix the handler read
  // only p.shopify_order_id, so this exact payload returned 'Missing shopify_order_id'.
  assert.equal(ref, "SC141808");
  // And it classifies to the human-facing order_number column (non-numeric, non-UUID).
  assert.deepEqual(moneyOrderMatch(ref!), { col: "order_number", val: "SC141808" });
});

test("resolveMoneyOrderRef accepts order_id (internal UUID) when that is the only key", () => {
  const uuid = "c2bc8bd8-2aca-4eeb-968b-dd968a3d0dbc";
  const ref = resolveMoneyOrderRef({ order_id: uuid });
  assert.equal(ref, uuid);
  assert.deepEqual(moneyOrderMatch(ref!), { col: "id", val: uuid });
});

test("resolveMoneyOrderRef prefers shopify_order_id, then order_number, then order_id", () => {
  assert.equal(
    resolveMoneyOrderRef({ shopify_order_id: "123", order_number: "SC1", order_id: "u" }),
    "123",
  );
  assert.equal(resolveMoneyOrderRef({ order_number: "SC1", order_id: "u" }), "SC1");
  assert.equal(resolveMoneyOrderRef({ order_id: "u" }), "u");
});

test("an all-digit shopify_order_id matches the shopify_order_id column", () => {
  assert.deepEqual(moneyOrderMatch("4512783901234"), {
    col: "shopify_order_id",
    val: "4512783901234",
  });
});

test("a payload naming no order at all is the only case that fails the guard", () => {
  assert.equal(resolveMoneyOrderRef({}), undefined);
});
