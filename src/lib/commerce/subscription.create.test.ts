/**
 * Unit tests for commerce/subscription.createSubscription's pure row-builder
 * (Phase 1 of docs/brain/specs/commerce-sdk-actions-create-order-create-subscription-refund-and-dollar-replacement.md).
 *
 * Pins the `buildCreateSubscriptionRow` shape — the invariant the
 * `createSubscription` wrapper relies on before calling
 * `admin.from("subscriptions").insert(...)`. No Supabase / no network — the
 * DB write itself is a thin call through this row.
 *
 * Run:
 *   npm run test:commerce-subscription-create
 *   (= tsx --test src/lib/commerce/subscription.create.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCreateSubscriptionRow,
  type CreateSubscriptionInput,
} from "./subscription";

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const CUSTOMER = "22222222-2222-2222-2222-222222222222";

function baseInput(overrides: Partial<CreateSubscriptionInput> = {}): CreateSubscriptionInput {
  return {
    vendor: "internal",
    customer_id: CUSTOMER,
    items: [{ variant_id: "v-1", title: "Monthly Superfood", quantity: 1 }],
    billing_interval: "month",
    billing_interval_count: 1,
    next_billing_date: "2026-08-01",
    ...overrides,
  };
}

test("buildCreateSubscriptionRow: defaults status to 'active' (spec verification bullet)", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput());
  assert.equal(row.status, "active");
});

test("buildCreateSubscriptionRow: caller can override status", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput({ status: "paused" }));
  assert.equal(row.status, "paused");
});

test("buildCreateSubscriptionRow: coerces YYYY-MM-DD next_billing_date to a UTC ISO timestamp (populated, spec verification bullet)", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput({ next_billing_date: "2026-08-01" }));
  assert.equal(row.next_billing_date, "2026-08-01T00:00:00.000Z");
});

test("buildCreateSubscriptionRow: leaves an already-ISO next_billing_date intact", () => {
  const iso = "2026-08-15T12:34:56.000Z";
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput({ next_billing_date: iso }));
  assert.equal(row.next_billing_date, iso);
});

test("buildCreateSubscriptionRow: vendor='internal' defaults is_internal=true", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput({ vendor: "internal" }));
  assert.equal(row.is_internal, true);
});

test("buildCreateSubscriptionRow: caller can force is_internal=false even on the internal branch", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput({ is_internal: false }));
  assert.equal(row.is_internal, false);
});

test("buildCreateSubscriptionRow: normalizes items into the on-row shape (line_id = variant_id when omitted, quantity defaults to 1)", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput({
    items: [{ variant_id: "v-77", title: "Berry Powder" }],
  }));
  const items = row.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0].line_id, "v-77");
  assert.equal(items[0].variant_id, "v-77");
  assert.equal(items[0].title, "Berry Powder");
  assert.equal(items[0].quantity, 1);
  assert.equal(items[0].is_gift, false);
  assert.equal(items[0].price_override_cents, null);
});

test("buildCreateSubscriptionRow: applies price_override_cents when caller specifies it (comp/grandfathered subs)", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput({
    items: [{ variant_id: "v-1", quantity: 2, price_override_cents: 0 }],
  }));
  const items = row.items as Array<Record<string, unknown>>;
  assert.equal(items[0].price_override_cents, 0);
  assert.equal(items[0].quantity, 2);
});

test("buildCreateSubscriptionRow: workspace_id + customer_id land on the row", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput());
  assert.equal(row.workspace_id, WORKSPACE);
  assert.equal(row.customer_id, CUSTOMER);
});

test("buildCreateSubscriptionRow: billing interval + count land on the row", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput({ billing_interval: "week", billing_interval_count: 4 }));
  assert.equal(row.billing_interval, "week");
  assert.equal(row.billing_interval_count, 4);
});

test("buildCreateSubscriptionRow: defaults empty applied_discounts + delivery_price_cents=0", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput());
  assert.deepEqual(row.applied_discounts, []);
  assert.equal(row.delivery_price_cents, 0);
});

test("buildCreateSubscriptionRow: shopify_contract_id null by default (post-insert synth via `internal-<uuid>`)", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput());
  assert.equal(row.shopify_contract_id, null);
});

test("buildCreateSubscriptionRow: caller-provided shopify_contract_id passes through", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput({ shopify_contract_id: "abc123" }));
  assert.equal(row.shopify_contract_id, "abc123");
});

test("buildCreateSubscriptionRow: opts.shopify_contract_id (synth) overrides the input field", () => {
  const row = buildCreateSubscriptionRow(WORKSPACE, baseInput({ shopify_contract_id: "abc123" }), {
    shopify_contract_id: "internal-9999",
  });
  assert.equal(row.shopify_contract_id, "internal-9999");
});
