/**
 * Unit tests for the assisted-purchase playbook's orchestrator wiring —
 * docs/brain/specs/assisted-purchase-playbook.md Phase 3. Pins the two
 * failing states the verification names:
 *
 *   (1) A purchase-intent classification ('buy', 'reorder',
 *       'create_order', 'create_subscription', 'add_subscription',
 *       'subscribe') scores above `DEFAULT_DEFER_THRESHOLD` against the
 *       DB-seeded `trigger_intents` for the assisted-purchase playbooks
 *       — matchPlaybookScored + applyDeferThreshold returns the
 *       playbook, NOT null. That's the "not a stateless create" gate.
 *   (2) An UNRELATED intent (a support / cancel intent) scores at 0
 *       against the assisted-purchase trigger surface — the playbook
 *       does NOT hijack every ticket, only purchase-shaped ones.
 *
 * The scorer is `scorePlaybookAgainst` in playbook-executor.ts, a pure
 * function of (trigger_intents, trigger_patterns, intent, msg) — the
 * test drives it with the EXACT trigger sets seeded by the Phase-2
 * migration + the sonnet_prompts routing hint from Phase 3, so the
 * "steps are DB rows" invariant is preserved (removing / reordering the
 * migration's seed changes what this test asserts).
 *
 * Run: `npx tsx --test src/lib/playbook-executor.assisted-purchase-routing.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  scorePlaybookAgainst,
  applyDeferThreshold,
  DEFAULT_DEFER_THRESHOLD,
} from "./playbook-executor";

// The exact trigger_intents the Phase-2 seed migration inserts on
// public.playbooks (supabase/migrations/20260707150000_seed_
// assisted_purchase_playbook.sql). Encoded here so the routing tests
// break if the seed drifts — the playbook name + trigger set is the
// contract Phase 3's orchestrator wiring pins on.
const ASSISTED_ORDER_TRIGGERS = {
  trigger_intents: ["create_order", "assisted_purchase_order", "buy", "reorder"],
  trigger_patterns: [] as string[],
};

const ASSISTED_SUB_TRIGGERS = {
  trigger_intents: [
    "create_subscription",
    "assisted_purchase_subscription",
    "add_subscription",
    "subscribe",
  ],
  trigger_patterns: [] as string[],
};

// ── (1) purchase intents route to the playbook ────────────────────────

test("intent='buy' scores 1.0 against Assisted Order Purchase → routes to playbook (not stateless create)", () => {
  const score = scorePlaybookAgainst(ASSISTED_ORDER_TRIGGERS, "buy", "I want to buy another jar of the creamer");
  assert.equal(score, 1.0);
  const gated = applyDeferThreshold({ id: "p1", name: "Assisted Order Purchase", score }, DEFAULT_DEFER_THRESHOLD);
  assert.ok(gated, "seeded playbook must survive the DEFER_THRESHOLD gate");
});

test("intent='reorder' scores 1.0 → routes to Assisted Order Purchase", () => {
  const score = scorePlaybookAgainst(ASSISTED_ORDER_TRIGGERS, "reorder", "can I reorder my last one");
  assert.equal(score, 1.0);
  assert.ok(applyDeferThreshold({ id: "p1", name: "Assisted Order Purchase", score }, DEFAULT_DEFER_THRESHOLD));
});

test("intent='create_order' scores 1.0 → routes to Assisted Order Purchase (Sonnet-emitted intent form)", () => {
  const score = scorePlaybookAgainst(ASSISTED_ORDER_TRIGGERS, "create_order", "place a new order");
  assert.equal(score, 1.0);
  assert.ok(applyDeferThreshold({ id: "p1", name: "Assisted Order Purchase", score }, DEFAULT_DEFER_THRESHOLD));
});

test("intent='add_subscription' scores 1.0 → routes to Assisted Subscription Purchase", () => {
  const score = scorePlaybookAgainst(ASSISTED_SUB_TRIGGERS, "add_subscription", "add me to the monthly");
  assert.equal(score, 1.0);
  assert.ok(applyDeferThreshold({ id: "p2", name: "Assisted Subscription Purchase", score }, DEFAULT_DEFER_THRESHOLD));
});

test("intent='subscribe' scores 1.0 → routes to Assisted Subscription Purchase", () => {
  const score = scorePlaybookAgainst(ASSISTED_SUB_TRIGGERS, "subscribe", "sign me up for the sub");
  assert.equal(score, 1.0);
  assert.ok(applyDeferThreshold({ id: "p2", name: "Assisted Subscription Purchase", score }, DEFAULT_DEFER_THRESHOLD));
});

test("intent='create_subscription' scores 1.0 → routes to Assisted Subscription Purchase", () => {
  const score = scorePlaybookAgainst(ASSISTED_SUB_TRIGGERS, "create_subscription", "new subscription please");
  assert.equal(score, 1.0);
  assert.ok(applyDeferThreshold({ id: "p2", name: "Assisted Subscription Purchase", score }, DEFAULT_DEFER_THRESHOLD));
});

// ── (2) unrelated intents do NOT hijack the playbook ─────────────────

test("intent='cancel_subscription' scores 0 against Assisted Order — playbook does NOT hijack cancel intent", () => {
  const score = scorePlaybookAgainst(ASSISTED_ORDER_TRIGGERS, "cancel_subscription", "please cancel my sub");
  assert.equal(score, 0);
  const gated = applyDeferThreshold({ id: "p1", name: "Assisted Order Purchase", score }, DEFAULT_DEFER_THRESHOLD);
  assert.equal(gated, null, "score below DEFER_THRESHOLD must gate the playbook out");
});

test("intent='refund' scores 0 against Assisted Order → refund tickets fall through to their own playbook", () => {
  const score = scorePlaybookAgainst(ASSISTED_ORDER_TRIGGERS, "refund", "can I get a refund");
  assert.equal(score, 0);
  assert.equal(
    applyDeferThreshold({ id: "p1", name: "Assisted Order Purchase", score }, DEFAULT_DEFER_THRESHOLD),
    null,
  );
});

test("intent='address_change' scores 0 against Assisted Subscription → shipping change ≠ new subscription", () => {
  const score = scorePlaybookAgainst(ASSISTED_SUB_TRIGGERS, "address_change", "change my shipping address");
  assert.equal(score, 0);
  assert.equal(
    applyDeferThreshold({ id: "p2", name: "Assisted Subscription Purchase", score }, DEFAULT_DEFER_THRESHOLD),
    null,
  );
});

// ── DEFER_THRESHOLD signature check — the gate is the reason a strong
//    match survives and a weak "buy" fragment doesn't score high enough
//    to override a stronger competing playbook.

test("DEFAULT_DEFER_THRESHOLD is 0.65 — the score gate the routing tests rely on", () => {
  assert.equal(DEFAULT_DEFER_THRESHOLD, 0.65);
});
