/**
 * Unit tests for commerce/order.createOrder's pure row-builder
 * (Phase 1 of docs/brain/specs/commerce-sdk-actions-create-order-create-subscription-refund-and-dollar-replacement.md).
 *
 * Pins the `buildCreateOrderRow` shape — the invariant the
 * `createOrder` wrapper relies on before calling `admin.from("orders").insert(...)`.
 * No Supabase / no network — the DB write itself is a thin call through
 * this row.
 *
 * Run:
 *   npm run test:commerce-order-create
 *   (= tsx --test src/lib/commerce/order.create.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildCreateOrderRow, type CreateOrderInput } from "./order";

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const CUSTOMER = "22222222-2222-2222-2222-222222222222";

function baseInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    vendor: "internal",
    customer_id: CUSTOMER,
    email: "buyer@example.com",
    line_items: [
      { variant_id: "v-1", title: "Superfood Powder", quantity: 2, unit_cents: 3999 },
    ],
    ...overrides,
  };
}

test("buildCreateOrderRow derives total_cents from the line-items sum", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput({
    line_items: [
      { variant_id: "v-1", title: "A", quantity: 2, unit_cents: 1000 },
      { variant_id: "v-2", title: "B", quantity: 3, unit_cents: 500 },
    ],
  }));
  assert.equal(row.total_cents, 2 * 1000 + 3 * 500);
});

test("buildCreateOrderRow stamps per-line price_cents + total_cents on each item (frozen at create time)", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput({
    line_items: [{ variant_id: "v-9", title: "Frozen", quantity: 3, unit_cents: 1500 }],
  }));
  const lines = row.line_items as Array<{ variant_id: string; price_cents: number; quantity: number; total_cents: number }>;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].variant_id, "v-9");
  assert.equal(lines[0].price_cents, 1500);
  assert.equal(lines[0].quantity, 3);
  assert.equal(lines[0].total_cents, 4500);
});

test("buildCreateOrderRow defaults currency to USD when caller omits it", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput());
  assert.equal(row.currency, "USD");
});

test("buildCreateOrderRow uses caller-supplied currency when provided", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput({ currency: "CAD" }));
  assert.equal(row.currency, "CAD");
});

test("buildCreateOrderRow tags source_name 'internal' on the internal branch", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput({ vendor: "internal" }));
  assert.equal(row.source_name, "internal");
});

test("buildCreateOrderRow tags source_name 'shopcx-created' on the shopify branch", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput({ vendor: "shopify" }));
  assert.equal(row.source_name, "shopcx-created");
});

test("buildCreateOrderRow: shopify_order_id + order_number are set from opts (populated by draft-complete)", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput({ vendor: "shopify" }), {
    shopify_order_id: "9876543210",
    order_number: "SC126001",
  });
  assert.equal(row.shopify_order_id, "9876543210");
  assert.equal(row.order_number, "SC126001");
});

test("buildCreateOrderRow: shopify_order_id absent on the internal branch (no upstream)", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput({ vendor: "internal" }));
  assert.equal(Object.prototype.hasOwnProperty.call(row, "shopify_order_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "order_number"), false);
});

test("buildCreateOrderRow: workspace_id + customer_id + email land on the row", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput());
  assert.equal(row.workspace_id, WORKSPACE);
  assert.equal(row.customer_id, CUSTOMER);
  assert.equal(row.email, "buyer@example.com");
});

test("buildCreateOrderRow: null customer_id / email pass through (guest checkout)", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput({ customer_id: null, email: null }));
  assert.equal(row.customer_id, null);
  assert.equal(row.email, null);
});

test("buildCreateOrderRow: financial_status='paid', fulfillment_status='unfulfilled' at create time", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput());
  assert.equal(row.financial_status, "paid");
  assert.equal(row.fulfillment_status, "unfulfilled");
});

test("buildCreateOrderRow: subscription_id + shipping_address + order_type pass through", () => {
  const row = buildCreateOrderRow(WORKSPACE, baseInput({
    subscription_id: "sub-uuid",
    shipping_address: { city: "Austin" },
    order_type: "recovery",
  }));
  assert.equal(row.subscription_id, "sub-uuid");
  assert.deepEqual(row.shipping_address, { city: "Austin" });
  assert.equal(row.order_type, "recovery");
});
