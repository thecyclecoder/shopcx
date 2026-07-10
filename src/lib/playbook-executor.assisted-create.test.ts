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

import { interpretAssistedCreateResult } from "./playbook-executor";

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

// ── invariant: 'complete' vs 'respond' — never accidental terminal on failure ──

test("invariant: action='complete' fires ONLY on success — the executor's terminal state must not be reached on failure", () => {
  for (const actionType of ["create_order", "create_subscription"] as const) {
    const okV = interpretAssistedCreateResult({ actionType, result: { success: true, summary: "ok" } });
    assert.equal(okV.action, "complete");
    const failV = interpretAssistedCreateResult({ actionType, result: { success: false, error: "e" } });
    assert.equal(failV.action, "respond", `failure of ${actionType} must NOT complete the playbook`);
  }
});
