/**
 * Pins the LIVE-ORCHESTRATOR ROUTING BOUNDARY for assisted-purchase playbooks
 * — the pure `extractAssistedPurchaseIntentFromDecision` helper the Sonnet
 * orchestrator's `handlePlaybook` calls when it routes into
 * `assisted-order-purchase` / `assisted-subscription-purchase`.
 *
 * The extracted intent is fed to [[resolveAssistedPurchaseIntentToParams]] so
 * `handleAssistedCreate` reads a populated `ctx.assisted_purchase_params`
 * instead of the empty object the pre-fix code produced (the infinite-loop
 * pattern from ticket 083201b5 — orchestrator picks pb:assisted_subscription_purchase,
 * the guard refuses on empty params, canned "which product and flavor..." reply
 * ships every turn).
 *
 * Spec: docs/brain/specs/live-orchestrator-assisted-purchase-carries-picked-item.md
 *
 * Run: `npx tsx --test src/lib/playbook-executor.orchestrator-assisted-intent.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractAssistedPurchaseIntentFromDecision } from "./playbook-executor";

test("assisted-order-purchase: create_order action → RawAssistedPurchaseIntent with variant_id + quantity", () => {
  const raw = extractAssistedPurchaseIntentFromDecision(
    {
      actions: [
        { type: "create_order", variant_id: "42614446260397", quantity: 2 },
      ],
    },
    "assisted-order-purchase",
  );
  assert.ok(raw, "must extract a non-null intent");
  assert.equal(raw!.actionType, "create_order");
  // Variant ref (Shopify id or UUID) passed straight through — findVariant
  // handles either shape in the id slot per src/lib/product-variants.ts:74-87.
  assert.equal(raw!.variantId, "42614446260397");
  assert.equal(raw!.quantity, 2);
  // Deliberately absent (sec:real-vuln) — no path from decision to price/vendor.
  assert.equal(raw!.title, null);
});

test("assisted-subscription-purchase: create_subscription action → carries interval + interval_count + nextBillingDate", () => {
  const raw = extractAssistedPurchaseIntentFromDecision(
    {
      actions: [
        {
          type: "create_subscription",
          variant_id: "42614446260397",
          quantity: 1,
          interval: "month",
          interval_count: 1,
          date: "2026-09-15",
        },
      ],
    },
    "assisted-subscription-purchase",
  );
  assert.ok(raw);
  assert.equal(raw!.actionType, "create_subscription");
  assert.equal(raw!.variantId, "42614446260397");
  assert.equal(raw!.quantity, 1);
  assert.equal(raw!.interval, "month");
  assert.equal(raw!.intervalCount, 1);
  // `date` maps to nextBillingDate (the orchestrator's ActionParams subset
  // exposes `date`; the Direction path uses `next_billing_date` directly).
  assert.equal(raw!.nextBillingDate, "2026-09-15");
});

test("actions[] empty or missing → null (caller must escalate, not start playbook with empty params)", () => {
  assert.equal(
    extractAssistedPurchaseIntentFromDecision({ actions: [] }, "assisted-order-purchase"),
    null,
  );
  assert.equal(
    extractAssistedPurchaseIntentFromDecision({}, "assisted-order-purchase"),
    null,
  );
});

test("no variant_id on any action → null (the empty-order guard would refuse; escalate at boundary)", () => {
  const raw = extractAssistedPurchaseIntentFromDecision(
    {
      actions: [
        { type: "create_order", quantity: 1 },
        { type: "apply_coupon" as unknown as string },
      ],
    },
    "assisted-order-purchase",
  );
  assert.equal(raw, null);
});

test("action_type mismatch but a sibling action carries variant_id → still extracts (uses first with variant_id)", () => {
  // The model has been seen attaching the create as a supplementary action
  // alongside `action_type:'playbook'`; treat any variant_id-carrying action
  // as the source of the intent so we don't strand the customer.
  const raw = extractAssistedPurchaseIntentFromDecision(
    {
      actions: [
        { type: "note_only" as unknown as string },
        { type: "create_order", variant_id: "42614446260397", quantity: 3 },
      ],
    },
    "assisted-order-purchase",
  );
  assert.ok(raw);
  assert.equal(raw!.variantId, "42614446260397");
  assert.equal(raw!.quantity, 3);
});

test("prefers the action_type-matching action over a sibling with a different type", () => {
  const raw = extractAssistedPurchaseIntentFromDecision(
    {
      actions: [
        { type: "note_only" as unknown as string, variant_id: "wrong-id", quantity: 99 },
        { type: "create_subscription", variant_id: "right-id", quantity: 1, interval: "month", interval_count: 1, date: "2026-10-01" },
      ],
    },
    "assisted-subscription-purchase",
  );
  assert.ok(raw);
  assert.equal(raw!.variantId, "right-id");
  assert.equal(raw!.quantity, 1);
});
