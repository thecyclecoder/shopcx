/**
 * Phase 4 of
 * docs/brain/specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol.md.
 *
 * Pins the two verification bullets that apply to the terminal create step of
 * the two assisted-purchase playbooks:
 *
 *   (a) Execute-then-confirm: the customer is told "placed" ONLY after the
 *       handler returned success:true. A failed handler NEVER emits a
 *       placement claim — the reply is an honest "ran into an issue" and NO
 *       `backedActions` is set (the claim-guard reads that as "no executed
 *       action to back the message-is-last check").
 *   (b) Exactly one order at the right price:
 *       - `interpretAssistedCreateResult({actionType:'create_order', result:{success:true, summary}})`
 *         returns `action:'complete'` + the one-time order response +
 *         `backedActions:['create_order']` (exactly ONE — no double dispatch).
 *       - Same for `'create_subscription'` — Sol's Subscribe & Save handoff
 *         path emits exactly one `backedActions:['create_subscription']`.
 *
 * The playbook's create step is DB-driven (supabase/migrations/20260707150000_
 * seed_assisted_purchase_playbook.sql seeds one create_order step for the
 * Assisted Order Purchase playbook and one create_subscription step for the
 * Assisted Subscription Purchase playbook), so the "exactly one" invariant
 * flows from (i) the seed migration inserting one step per playbook, (ii) the
 * playbook step engine advancing to the next step only once per execution turn,
 * and (iii) this interpreter emitting `action:'complete'` (a terminal state,
 * per the executor loop) on success. The pure interpreter covers slice (iii);
 * the seed migration is verified by playbook-executor.assisted-purchase-routing.test.ts.
 *
 * Pure — no DB, no network. Run:
 *   npx tsx --test src/lib/playbook-executor.assisted-create.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  interpretAssistedCreateResult,
  assistedCreateMissingItemsGuard,
  buildAssistedPurchaseParams,
} from "./playbook-executor";

// ── (a) execute-then-confirm: success only after success ──────────────────

test("execute-then-confirm: create_order success → 'Your order is placed and on its way' + backedActions", () => {
  const v = interpretAssistedCreateResult({
    actionType: "create_order",
    result: { success: true, summary: "order SC1234 charged $46.00 to vaulted PM 0011" },
  });
  assert.equal(v.action, "complete");
  assert.match(v.response, /Your order is placed and on its way/);
  assert.deepEqual(v.backedActions, ["create_order"], "exactly one action backing the reply");
  assert.equal(v.context.assisted_purchase_completed, true);
  assert.match(String(v.context.assisted_purchase_result_summary), /order SC1234/);
});

test("execute-then-confirm: create_subscription success → 'Your subscription is set up' + backedActions", () => {
  const v = interpretAssistedCreateResult({
    actionType: "create_subscription",
    result: { success: true, summary: "subscription sub_99 created at $41.40 discounted price" },
  });
  assert.equal(v.action, "complete");
  assert.match(v.response, /Your subscription is set up/);
  assert.deepEqual(v.backedActions, ["create_subscription"], "exactly one action backing the reply");
  assert.equal(v.context.assisted_purchase_completed, true);
  assert.match(String(v.context.assisted_purchase_result_summary), /sub_99/);
});

test("execute-then-confirm: create_order FAILURE → honest 'ran into an issue' reply + NO placement claim + NO backedActions", () => {
  const v = interpretAssistedCreateResult({
    actionType: "create_order",
    result: { success: false, error: "Braintree charge declined (CVV mismatch)" },
    personaName: "Suzie",
  });
  assert.equal(v.action, "respond", "a failed handler must NOT emit action='complete' (no terminal on failure)");
  assert.match(v.response, /Suzie ran into an issue finishing this/);
  assert.doesNotMatch(v.response, /placed|on its way|is set up|is placed/i, "the failure reply must never claim placed");
  assert.equal(
    v.backedActions,
    undefined,
    "a failed handler leaves backedActions unset — the claim-guard sees no action backing the message-is-last check",
  );
  assert.equal(v.context.assisted_purchase_last_error, "Braintree charge declined (CVV mismatch)");
});

test("execute-then-confirm: create_subscription FAILURE → honest reply + NO placement claim + NO backedActions", () => {
  const v = interpretAssistedCreateResult({
    actionType: "create_subscription",
    result: { success: false, error: "vaulted PM expired" },
  });
  assert.equal(v.action, "respond");
  assert.match(v.response, /our team ran into an issue finishing this/);
  assert.doesNotMatch(v.response, /placed|on its way|is set up/i);
  assert.equal(v.backedActions, undefined);
});

test("execute-then-confirm: on failure, no context key claims completion", () => {
  const v = interpretAssistedCreateResult({
    actionType: "create_order",
    result: { success: false, error: "network timeout" },
  });
  assert.notEqual(v.context.assisted_purchase_completed, true);
  assert.equal(v.context.assisted_purchase_last_error, "network timeout");
});

// ── (b) exactly-one-order-at-the-right-price ────────────────────────────

test("exactly-one: create_order success emits exactly ONE backedAction (create_order) — no duplicate dispatch", () => {
  const v = interpretAssistedCreateResult({
    actionType: "create_order",
    result: { success: true, summary: "one-time order $46.00" },
  });
  assert.ok(Array.isArray(v.backedActions));
  assert.equal(v.backedActions?.length, 1, "exactly one — never two orders per playbook completion");
  assert.equal(v.backedActions?.[0], "create_order");
});

test("exactly-one: create_subscription success emits exactly ONE backedAction (create_subscription) — no duplicate dispatch", () => {
  const v = interpretAssistedCreateResult({
    actionType: "create_subscription",
    result: { success: true, summary: "S&S at $41.40" },
  });
  assert.equal(v.backedActions?.length, 1);
  assert.equal(v.backedActions?.[0], "create_subscription");
});

test("exactly-one: the summary string SURFACES on the ledger context — a downstream analytics slice can read the actual charged price", () => {
  // Verification bullet 2 — sandbox/harness on a test fixture, OR code-path
  // assertion up to the external Braintree edge. The interpreter is that
  // code-path assertion: the summary the create_order handler emits (which
  // contains the charged price) is stashed on the context so downstream
  // analytics can read it deterministically.
  const priceSummary = "order SC1234 charged $46.00 to vaulted PM 0011";
  const v = interpretAssistedCreateResult({
    actionType: "create_order",
    result: { success: true, summary: priceSummary },
  });
  assert.equal(v.context.assisted_purchase_result_summary, priceSummary);
});

// ── Phase 1: empty-order guard — the terminal step refuses to place an empty order ──
//
// Spec: an-assisted-purchase-carries-the-item-the-customer-actually-picked.md Phase 1.
// A merged payload with no resolvable line items must never reach the create effector;
// the refusal is RECOVERABLE ('respond', not 'complete') and asks the customer what to
// order — the generic "ran into an issue finishing this" reply is reserved for a genuine
// handler failure and must not be used for this case. A distinct system note keeps the
// two separable in logs.

test("empty-order guard: create_order with missing line_items → refuse + ask what to order + distinct systemNote", () => {
  const v = assistedCreateMissingItemsGuard({
    actionType: "create_order",
    params: { vendor: "internal" },
  });
  assert.ok(v, "no line_items → must produce a refusal (never null)");
  assert.equal(v!.action, "respond", "the refusal must be RECOVERABLE — never 'complete'");
  assert.doesNotMatch(
    v!.response,
    /ran into an issue finishing this/,
    "the generic handler-failure reply must NOT be reused for the empty-order case",
  );
  assert.match(
    v!.response,
    /which product|what.*would you like|which flavor/i,
    "the refusal must ASK the customer what to order so they can answer in one reply",
  );
  assert.match(
    v!.systemNote,
    /line[_ ]?items|no items|empty order/i,
    "the systemNote must be separable in the logs from a genuine handler failure",
  );
});

test("empty-order guard: create_order with empty line_items array → refuse", () => {
  const v = assistedCreateMissingItemsGuard({
    actionType: "create_order",
    params: { vendor: "internal", line_items: [] },
  });
  assert.ok(v);
  assert.equal(v!.action, "respond");
});

test("empty-order guard: create_order with malformed line_items (missing variant_id) → refuse", () => {
  const v = assistedCreateMissingItemsGuard({
    actionType: "create_order",
    params: { vendor: "internal", line_items: [{ title: "Mixed Berry", quantity: 1 }] },
  });
  assert.ok(v, "an item without a variant_id is malformed — must refuse rather than dispatch");
  assert.equal(v!.action, "respond");
});

test("empty-order guard: create_subscription with missing items → refuse + ask what to order", () => {
  const v = assistedCreateMissingItemsGuard({
    actionType: "create_subscription",
    params: { vendor: "internal", interval: "month", interval_count: 1 },
  });
  assert.ok(v);
  assert.equal(v!.action, "respond");
  assert.match(v!.response, /which product|what.*would you like|which flavor/i);
});

test("empty-order guard: create_subscription with a fully-formed item → passes (returns null; do not refuse)", () => {
  const v = assistedCreateMissingItemsGuard({
    actionType: "create_subscription",
    params: {
      vendor: "internal",
      items: [{ variant_id: "550e8400-e29b-41d4-a716-446655440000", quantity: 1 }],
    },
  });
  assert.equal(v, null, "well-formed items must not trip the guard");
});

test("empty-order guard: create_order with a fully-formed line_item → passes (returns null)", () => {
  const v = assistedCreateMissingItemsGuard({
    actionType: "create_order",
    params: {
      vendor: "internal",
      line_items: [{ variant_id: "550e8400-e29b-41d4-a716-446655440000", quantity: 1 }],
    },
  });
  assert.equal(v, null);
});

// ── Phase 1: interpretAssistedCreateResult must not promise a "quick review" ──
//
// The 2026-08-13 Corrie ticket promised "I've flagged it for a quick review." The only
// thing that actually happened was a CEO card that sat unread for four days. The spec
// says: "Do not leave a sentence in the product that promises work no component
// performs."

test("honest failure text: failure reply must not claim a review is scheduled", () => {
  for (const actionType of ["create_order", "create_subscription"] as const) {
    const v = interpretAssistedCreateResult({
      actionType,
      result: { success: false, error: "some upstream error" },
      personaName: "Suzie",
    });
    assert.equal(v.action, "respond");
    assert.doesNotMatch(
      v.response,
      /flagged.*review|scheduled.*review|for a quick review/i,
      "the failure reply must not promise a review that is not owned by any component",
    );
  }
});

// ── Phase 2: buildAssistedPurchaseParams — the missing writer ─────────────
//
// Spec: an-assisted-purchase-carries-the-item-the-customer-actually-picked.md Phase 2.
// A pure writer that turns a routed purchase intent (variant + quantity + subscription
// details) into the `assisted_purchase_params` shape [[handleAssistedCreate]] reads at
// :1450. Variant refs MUST be the internal UUID (Shopify is being sunset).

const UUID_A = "550e8400-e29b-41d4-a716-446655440000";

test("buildAssistedPurchaseParams: create_order → { vendor, line_items:[{variant_id, quantity}] }", () => {
  const p = buildAssistedPurchaseParams({
    actionType: "create_order",
    variantId: UUID_A,
    title: "Mixed Berry",
    quantity: 2,
    unitCents: 4600,
  });
  assert.ok(p, "well-formed intent must produce params (never null)");
  assert.equal((p as { vendor: string }).vendor, "internal");
  const items = (p as { line_items: Array<Record<string, unknown>> }).line_items;
  assert.equal(items.length, 1);
  assert.equal(items[0].variant_id, UUID_A);
  assert.equal(items[0].quantity, 2);
  assert.equal(items[0].title, "Mixed Berry");
  assert.equal(items[0].unit_cents, 4600);
});

test("buildAssistedPurchaseParams: create_subscription → { vendor, items[], interval, interval_count, next_billing_date }", () => {
  const p = buildAssistedPurchaseParams({
    actionType: "create_subscription",
    variantId: UUID_A,
    title: "Mixed Berry",
    quantity: 1,
    interval: "month",
    intervalCount: 1,
    nextBillingDate: "2026-09-13",
  });
  assert.ok(p);
  const items = (p as { items: Array<Record<string, unknown>> }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].variant_id, UUID_A);
  assert.equal((p as { interval: string }).interval, "month");
  assert.equal((p as { interval_count: number }).interval_count, 1);
  assert.equal((p as { next_billing_date: string }).next_billing_date, "2026-09-13");
});

test("buildAssistedPurchaseParams: shopify-numeric-id in variant_id slot → null (Shopify-is-sunset invariant)", () => {
  const p = buildAssistedPurchaseParams({
    actionType: "create_order",
    variantId: "42614433448109", // the exact shopify id Corrie's confirm turn logged
    quantity: 1,
  });
  assert.equal(p, null, "a shopify numeric id must not be accepted as an internal variant_id");
});

test("buildAssistedPurchaseParams: create_subscription without interval → null (SDK requires interval)", () => {
  const p = buildAssistedPurchaseParams({
    actionType: "create_subscription",
    variantId: UUID_A,
    quantity: 1,
    // no interval / interval_count / next_billing_date
  });
  assert.equal(p, null);
});

test("buildAssistedPurchaseParams: params shape flows through the Phase-1 empty-order guard as WELL-FORMED", () => {
  // The writer's output is exactly the input the terminal step reads at :1450, so
  // running the pre-dispatch guard against it must return null (do not refuse).
  const orderParams = buildAssistedPurchaseParams({
    actionType: "create_order",
    variantId: UUID_A,
    quantity: 1,
  });
  assert.ok(orderParams);
  assert.equal(
    assistedCreateMissingItemsGuard({ actionType: "create_order", params: orderParams! }),
    null,
    "writer output must satisfy the reader's guard — round-trip contract",
  );
  const subParams = buildAssistedPurchaseParams({
    actionType: "create_subscription",
    variantId: UUID_A,
    quantity: 1,
    interval: "month",
    intervalCount: 1,
    nextBillingDate: "2026-09-13",
  });
  assert.ok(subParams);
  assert.equal(
    assistedCreateMissingItemsGuard({ actionType: "create_subscription", params: subParams! }),
    null,
  );
});

test("buildAssistedPurchaseParams: quantity < 1 → floors to 1 (never dispatch a zero-quantity order)", () => {
  const p = buildAssistedPurchaseParams({
    actionType: "create_order",
    variantId: UUID_A,
    quantity: 0,
  });
  assert.ok(p);
  const items = (p as { line_items: Array<Record<string, unknown>> }).line_items;
  assert.equal(items[0].quantity, 1);
});

// ── invariant: 'complete' vs 'respond' — never accidental terminal on failure ──

test("invariant: action='complete' fires ONLY on success — the executor's terminal state must not be reached on failure", () => {
  for (const actionType of ["create_order", "create_subscription"] as const) {
    const okV = interpretAssistedCreateResult({ actionType, result: { success: true, summary: "ok" } });
    assert.equal(okV.action, "complete");
    const failV = interpretAssistedCreateResult({ actionType, result: { success: false, error: "e" } });
    assert.equal(failV.action, "respond", `failure of ${actionType} must NOT complete the playbook`);
  }
});
