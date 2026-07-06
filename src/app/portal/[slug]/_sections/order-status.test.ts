/**
 * Unit tests for the PURE three-state (Created / Shipped / Delivered) portal
 * order-status classifier. Built-in node:test — no runner dependency. Run:
 *   npx tsx --test src/app/portal/[slug]/_sections/order-status.test.ts
 *
 * These assertions mirror the Phase 3 verification bullets exactly — old
 * fulfilled/delivered orders read Shipped or Delivered (never 'in transit'),
 * internal orders resolve via shopify_order_id-null keying, and Cancelled /
 * Refunded still render as their own tags.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deliveryStatusTag, financialTag, type OrderStatusInput } from "./order-status";

const NOW = new Date("2026-07-06T12:00:00Z").getTime();

const base = (o: Partial<OrderStatusInput> = {}): OrderStatusInput => ({
  shopify_order_id: null,
  fulfillment_status: null,
  delivered_at: null,
  easypost_status: null,
  amplifier_tracking_number: null,
  amplifier_status: null,
  financial_status: "paid",
  created_at: new Date(NOW - 30 * 24 * 3600 * 1000).toISOString(),
  ...o,
});

test("no order ever renders as 'in transit' or 'processing' — the classifier only returns Created/Shipped/Delivered", () => {
  // Iterate a matrix; every returned label must be one of the three.
  const allowed = new Set(["Created", "Shipped", "Delivered"]);
  const fixtures: Array<Partial<OrderStatusInput>> = [
    {},
    { shopify_order_id: null, fulfillment_status: null, amplifier_tracking_number: null, created_at: new Date(NOW - 3 * 24 * 3600 * 1000).toISOString() },
    { shopify_order_id: "9999", fulfillment_status: null },
    { shopify_order_id: "9999", fulfillment_status: "fulfilled" },
    { shopify_order_id: null, amplifier_tracking_number: "T1" },
    { shopify_order_id: null, fulfillment_status: "fulfilled" },
    { shopify_order_id: null, delivered_at: new Date(NOW).toISOString() },
    { shopify_order_id: "9999", easypost_status: "delivered" },
  ];
  for (const f of fixtures) {
    const tag = deliveryStatusTag(base(f), NOW);
    assert.equal(allowed.has(tag.label), true, `unexpected label "${tag.label}" for fixture ${JSON.stringify(f)}`);
  }
});

test("internal order with tracking → Shipped (verification bullet 2)", () => {
  const tag = deliveryStatusTag(base({ shopify_order_id: null, amplifier_tracking_number: "T1" }), NOW);
  assert.equal(tag.label, "Shipped");
});

test("internal order with delivered_at → Delivered (verification bullet 2)", () => {
  const tag = deliveryStatusTag(base({ shopify_order_id: null, delivered_at: new Date(NOW - 3600_000).toISOString() }), NOW);
  assert.equal(tag.label, "Delivered");
});

test("fresh internal order (no tracking, <7d, not fulfilled) → Created (verification bullet 2)", () => {
  const tag = deliveryStatusTag(
    base({
      shopify_order_id: null,
      amplifier_tracking_number: null,
      fulfillment_status: null,
      created_at: new Date(NOW - 3 * 24 * 3600 * 1000).toISOString(),
    }),
    NOW,
  );
  assert.equal(tag.label, "Created");
});

test("internal order, no tracking, fulfilled, >7d → Shipped (aged-fulfillment infers Shipped, matches the mutation-guard grace)", () => {
  const tag = deliveryStatusTag(
    base({
      shopify_order_id: null,
      amplifier_tracking_number: null,
      fulfillment_status: "fulfilled",
      created_at: new Date(NOW - 30 * 24 * 3600 * 1000).toISOString(),
    }),
    NOW,
  );
  assert.equal(tag.label, "Shipped");
});

test("internal order, no tracking, no fulfillment_status, paid, >7d → Shipped (aged-paid fallback — old orders never limbo)", () => {
  const tag = deliveryStatusTag(
    base({
      shopify_order_id: null,
      amplifier_tracking_number: null,
      fulfillment_status: null,
      financial_status: "paid",
      created_at: new Date(NOW - 90 * 24 * 3600 * 1000).toISOString(),
    }),
    NOW,
  );
  assert.equal(tag.label, "Shipped");
});

test("internal order, no tracking, refunded, >7d → Created (aged fallback does NOT fire when refunded/voided)", () => {
  const tag = deliveryStatusTag(
    base({
      shopify_order_id: null,
      amplifier_tracking_number: null,
      fulfillment_status: null,
      financial_status: "refunded",
      created_at: new Date(NOW - 90 * 24 * 3600 * 1000).toISOString(),
    }),
    NOW,
  );
  assert.equal(tag.label, "Created");
});

test("Shopify order (shopify_order_id present) + fulfillment_status=fulfilled → Shipped", () => {
  const tag = deliveryStatusTag(
    base({ shopify_order_id: "9999", fulfillment_status: "fulfilled" }),
    NOW,
  );
  assert.equal(tag.label, "Shipped");
});

test("Shopify order + fulfillment_status=null → Created (never Processing)", () => {
  const tag = deliveryStatusTag(
    base({ shopify_order_id: "9999", fulfillment_status: null }),
    NOW,
  );
  assert.equal(tag.label, "Created");
});

test("Shopify order + easypost_status=delivered → Delivered", () => {
  const tag = deliveryStatusTag(
    base({ shopify_order_id: "9999", easypost_status: "delivered" }),
    NOW,
  );
  assert.equal(tag.label, "Delivered");
});

test("delivery tag never returns Cancelled/Refunded — those are separate financial tags", () => {
  // Even a cancelled order still gets a delivery lane (usually Created since it
  // never shipped). The Cancelled badge is rendered separately via financialTag.
  const tag = deliveryStatusTag(base({ amplifier_status: "Cancelled", financial_status: "voided" }), NOW);
  assert.notEqual(tag.label, "Cancelled");
  assert.notEqual(tag.label, "Refunded");
});

test("financialTag: amplifier_status=Cancelled → Cancelled (verification bullet 3)", () => {
  const tag = financialTag(base({ amplifier_status: "Cancelled" }));
  assert.equal(tag?.label, "Cancelled");
});

test("financialTag: financial_status=refunded → Refunded (verification bullet 3)", () => {
  const tag = financialTag(base({ financial_status: "refunded" }));
  assert.equal(tag?.label, "Refunded");
});

test("financialTag: financial_status=partially_refunded → Refunded", () => {
  const tag = financialTag(base({ financial_status: "partially_refunded" }));
  assert.equal(tag?.label, "Refunded");
});

test("financialTag: financial_status=voided → Cancelled", () => {
  const tag = financialTag(base({ financial_status: "voided" }));
  assert.equal(tag?.label, "Cancelled");
});

test("financialTag: paid order → null (uninteresting, no tag)", () => {
  const tag = financialTag(base({ financial_status: "paid" }));
  assert.equal(tag, null);
});
